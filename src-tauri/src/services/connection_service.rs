//! Connection management — CRUD plus the working-call paths (`ping`,
//! `list_models`, `complete`). Keeps API keys server-side; the frontend only
//! ever sees the redacted `ConnectionInfo`.

use uuid::Uuid;

use crate::models::{
    ChatMessage, CompletionParams, CompletionResult, ConnectionInfo, ConnectionInput,
    ConnectionKind,
};
use crate::providers;
use crate::storage::repositories::{ConnectionRepo, ConnectionRow};
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct ConnectionService {
    repo: ConnectionRepo,
}

impl ConnectionService {
    pub fn new(repo: ConnectionRepo) -> Self {
        Self { repo }
    }

    pub async fn list(&self) -> AppResult<Vec<ConnectionInfo>> {
        let rows = self.repo.list().await?;
        Ok(rows.into_iter().map(redact).collect())
    }

    /// Persist a new or edited connection. If `input.api_key` is empty AND
    /// we're updating an existing row, preserve the row's current key (lets
    /// the user edit a label or model without re-typing the secret).
    pub async fn save(&self, input: ConnectionInput) -> AppResult<ConnectionInfo> {
        validate(&input)?;

        let id = input.id.clone().filter(|s| !s.is_empty()).unwrap_or_else(new_id);

        let api_key = if input.api_key.trim().is_empty() {
            match self.repo.get(&id).await {
                Ok(existing) => existing.api_key,
                Err(_) => String::new(), // new row, no prior key — fine, save empty
            }
        } else {
            input.api_key.clone()
        };

        let row = ConnectionRow {
            id: id.clone(),
            label: input.label.trim().to_string(),
            kind: input.kind.clone(),
            base_url: input.base_url.trim().to_string(),
            api_key,
            default_model: input.default_model.trim().to_string(),
            is_default: input.is_default,
        };

        self.repo.upsert(&row).await?;
        if row.is_default {
            self.repo.clear_other_defaults(&row.id).await?;
        }

        let saved = self.repo.get(&row.id).await?;
        Ok(redact(saved))
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        self.repo.delete(id).await
    }

    pub async fn set_default(&self, id: &str) -> AppResult<()> {
        // Confirm the row exists before flipping any flags.
        let mut row = self.repo.get(id).await?;
        row.is_default = true;
        self.repo.upsert(&row).await?;
        self.repo.clear_other_defaults(id).await?;
        Ok(())
    }

    pub async fn ping(&self, id: &str) -> AppResult<()> {
        let row = self.repo.get(id).await?;
        providers::ping(&row).await
    }

    pub async fn list_models(&self, id: &str) -> AppResult<Vec<String>> {
        let row = self.repo.get(id).await?;
        providers::list_models(&row).await
    }

    /// Run a chat completion through a specific connection.
    pub async fn complete(
        &self,
        id: &str,
        messages: Vec<ChatMessage>,
        params: CompletionParams,
    ) -> AppResult<CompletionResult> {
        let row = self.repo.get(id).await?;
        providers::complete(&row, messages, params).await
    }

    /// Convenience for callers that just want "use whatever the user picked":
    /// completes against the default connection. Errors clearly if none set.
    pub async fn complete_default(
        &self,
        messages: Vec<ChatMessage>,
        params: CompletionParams,
    ) -> AppResult<CompletionResult> {
        let row = self
            .repo
            .get_default()
            .await?
            .ok_or_else(|| AppError::Validation("no default connection configured".into()))?;
        providers::complete(&row, messages, params).await
    }
}

fn validate(input: &ConnectionInput) -> AppResult<()> {
    if input.label.trim().is_empty() {
        return Err(AppError::Validation("label is required".into()));
    }
    if input.base_url.trim().is_empty() {
        return Err(AppError::Validation("base URL is required".into()));
    }
    if !input.base_url.starts_with("http://") && !input.base_url.starts_with("https://") {
        return Err(AppError::Validation("base URL must start with http(s)://".into()));
    }
    if ConnectionKind::from_db(&input.kind).is_none() {
        return Err(AppError::Validation(format!(
            "unknown connection kind '{}'; expected 'openai' or 'anthropic'",
            input.kind
        )));
    }
    Ok(())
}

fn redact(row: ConnectionRow) -> ConnectionInfo {
    let has_key = !row.api_key.is_empty();
    let tail = if row.api_key.len() > 4 {
        format!("…{}", &row.api_key[row.api_key.len() - 4..])
    } else if has_key {
        "…".into()
    } else {
        String::new()
    };
    ConnectionInfo {
        id: row.id,
        label: row.label,
        kind: row.kind,
        base_url: row.base_url,
        api_key_tail: tail,
        has_key,
        default_model: row.default_model,
        is_default: row.is_default,
    }
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}
