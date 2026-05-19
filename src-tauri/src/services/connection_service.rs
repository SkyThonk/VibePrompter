//! Connection management — CRUD plus the working-call paths (`ping`,
//! `list_models`, `complete`). API keys live in the OS keyring (see
//! `crate::security`); the SQLite row's `api_key` column is only used for
//! one-shot migration from older builds that stored them plaintext.

use std::sync::Arc;

use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::models::{
    ChatMessage, CompletionParams, CompletionResult, ConnectionInfo, ConnectionInput,
    ConnectionKind,
};
use crate::providers::{self, HttpConfig};
use crate::security::{connection_account, SecretStore};
use crate::services::SettingsService;
use crate::storage::repositories::{ConnectionRepo, ConnectionRow};
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct ConnectionService {
    repo: ConnectionRepo,
    secrets: Arc<dyn SecretStore>,
    settings: SettingsService,
    /// Bounded concurrent outbound HTTP calls. Sized from
    /// `Settings.concurrent_requests` at startup. Resizing requires a
    /// restart — the underlying `Semaphore` permit count is fixed.
    permits: Arc<Semaphore>,
    /// Mirror of the semaphore's original capacity so we can return it
    /// without touching tokio's internal accounting.
    permits_cap: u32,
}

impl ConnectionService {
    pub fn new(
        repo: ConnectionRepo,
        secrets: Arc<dyn SecretStore>,
        settings: SettingsService,
        max_concurrent: u32,
    ) -> Self {
        let n = max_concurrent.clamp(1, 64) as usize;
        Self {
            repo,
            secrets,
            settings,
            permits: Arc::new(Semaphore::new(n)),
            permits_cap: n as u32,
        }
    }

    /// Best-effort observation of how many outbound calls are currently
    /// holding a permit. Computed from the gap between configured capacity
    /// and available permits — exact at the instant of read, racy by the
    /// time the value reaches the UI. Used only for the dashboard's
    /// "in-flight" badge so a small racy gap is fine.
    pub fn in_flight(&self) -> u32 {
        let total = self.permits.available_permits();
        // We can't read the original capacity directly from `Semaphore` —
        // but we don't need to. The dashboard cares about the bar between
        // 0 (nothing in flight) and "concurrent_requests" (saturated); we
        // surface that via two numbers: a count of acquired permits, and
        // a separate `concurrent_limit()` for the denominator.
        self.permits_capacity().saturating_sub(total as u32)
    }

    pub fn permits_capacity(&self) -> u32 {
        // The `Semaphore` was sized from `Settings.concurrent_requests` at
        // boot; we stash the same number alongside it to avoid the
        // capacity-tracking dance.
        self.permits_cap
    }

    /// Pull the live `HttpConfig` from settings. Called before every outbound
    /// HTTP call so users' changes to timeout/proxy take effect immediately
    /// without an app restart.
    pub async fn http_config(&self) -> HttpConfig {
        match self.settings.get().await {
            Ok(s) => HttpConfig::from_settings(&s),
            Err(_) => HttpConfig::default(),
        }
    }

    /// Materialize a row with its API key hydrated from the keyring. Used by
    /// every code path that needs to actually call the vendor.
    fn hydrate(&self, mut row: ConnectionRow) -> ConnectionRow {
        if row.api_key.is_empty() {
            if let Some(secret) = self.secrets.get(&connection_account(&row.id)) {
                row.api_key = secret;
            }
        }
        row
    }

    /// One-shot migration on startup: move any plaintext `api_key` values
    /// out of SQLite and into the keyring, then blank the DB column. Safe
    /// to call on every boot — rows with empty `api_key` are skipped.
    pub async fn migrate_keys_to_keyring(&self) -> AppResult<usize> {
        let rows = self.repo.list().await?;
        let mut moved = 0usize;
        for row in rows {
            if row.api_key.is_empty() {
                continue;
            }
            if let Err(e) = self.secrets.set(&connection_account(&row.id), &row.api_key) {
                tracing::warn!("keyring write failed for {}: {e}", row.id);
                continue;
            }
            // Re-fetch then upsert with empty key to scrub the column.
            let mut blanked = row.clone();
            blanked.api_key = String::new();
            if let Err(e) = self.repo.upsert(&blanked).await {
                tracing::warn!("blanking api_key for {} failed: {e}", row.id);
            } else {
                moved += 1;
            }
        }
        if moved > 0 {
            tracing::info!("migrated {moved} api key(s) from SQLite into the keyring");
        }
        Ok(moved)
    }

    pub async fn list(&self) -> AppResult<Vec<ConnectionInfo>> {
        let rows = self.repo.list().await?;
        Ok(rows
            .into_iter()
            .map(|mut r| {
                // For display purposes (redaction tail + hasKey flag) we need
                // to know if the keyring has a value, not just the DB column.
                let secret = self.secrets.get(&connection_account(&r.id));
                if let Some(s) = secret {
                    r.api_key = s;
                }
                redact(r)
            })
            .collect())
    }

    /// Persist a new or edited connection. If `input.api_key` is empty AND
    /// we're updating an existing row, preserve the row's current key (lets
    /// the user edit a label or model without re-typing the secret).
    pub async fn save(&self, input: ConnectionInput) -> AppResult<ConnectionInfo> {
        validate(&input)?;

        let id = input.id.clone().filter(|s| !s.is_empty()).unwrap_or_else(new_id);
        let account = connection_account(&id);

        // Resolve which key to persist to the keyring:
        //   - empty input + existing keyring entry → keep what's there
        //   - empty input + no existing → save nothing
        //   - non-empty → overwrite
        if !input.api_key.trim().is_empty() {
            if let Err(e) = self.secrets.set(&account, &input.api_key) {
                return Err(AppError::Config(format!("save key to keyring: {e}")));
            }
        }

        // If no connection currently exists, this one is automatically the
        // default — otherwise users save a single connection and then hit
        // "no default connection" on their first prompt. Same idea as
        // "make the only Wi-Fi network you've configured your default".
        let existing = self.repo.list().await.unwrap_or_default();
        let auto_default = existing.is_empty();

        let row = ConnectionRow {
            id: id.clone(),
            label: input.label.trim().to_string(),
            kind: input.kind.clone(),
            base_url: input.base_url.trim().to_string(),
            // The DB column stays empty going forward — keys live in the
            // keyring. The redact() helper reads from the keyring instead.
            api_key: String::new(),
            default_model: input.default_model.trim().to_string(),
            is_default: input.is_default || auto_default,
            extra_headers: input.extra_headers.trim().to_string(),
            // The DB has a NOT NULL DEFAULT '' so this only matters for the
            // ConnectionRow we hand back from save() to redact for the UI.
            last_used_at: String::new(),
            notes: input.notes.clone(),
        };

        self.repo.upsert(&row).await?;
        if row.is_default {
            self.repo.clear_other_defaults(&row.id).await?;
        }

        // Build the response: redacted, with `hasKey` reflecting keyring state.
        let mut display = self.repo.get(&row.id).await?;
        if let Some(secret) = self.secrets.get(&account) {
            display.api_key = secret;
        }
        Ok(redact(display))
    }

    /// Export all connections as a serializable JSON payload — API keys are
    /// deliberately omitted. Recipients add their own keys after import.
    pub async fn export_all(&self) -> AppResult<serde_json::Value> {
        let rows = self.repo.list().await?;
        let items: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "id": r.id,
                    "label": r.label,
                    "kind": r.kind,
                    "baseUrl": r.base_url,
                    "defaultModel": r.default_model,
                    "isDefault": r.is_default,
                    "extraHeaders": r.extra_headers,
                    "notes": r.notes,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "schema": "vibeprompter-connections-v1",
            "exportedAt": chrono::Utc::now().to_rfc3339(),
            "connections": items,
        }))
    }

    /// Import a payload produced by `export_all`. Duplicate ids are skipped
    /// unless `overwrite` is true. Returns the number of rows imported.
    pub async fn import_all(
        &self,
        payload: serde_json::Value,
        overwrite: bool,
    ) -> AppResult<usize> {
        let connections = payload
            .get("connections")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Validation("payload missing `connections` array".into()))?;

        let existing_ids: std::collections::HashSet<String> = self
            .repo
            .list()
            .await?
            .into_iter()
            .map(|r| r.id)
            .collect();

        let mut imported = 0usize;
        for item in connections {
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let id = if id.is_empty() { new_id() } else { id };

            if existing_ids.contains(&id) && !overwrite {
                continue;
            }

            let row = ConnectionRow {
                id: id.clone(),
                label: item
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Imported")
                    .to_string(),
                kind: item
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("openai")
                    .to_string(),
                base_url: item
                    .get("baseUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                api_key: String::new(),
                default_model: item
                    .get("defaultModel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                // Imported rows never auto-claim default — would surprise the
                // user by silently switching their working connection.
                is_default: false,
                extra_headers: item
                    .get("extraHeaders")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                // Imported rows start fresh — no last-used history.
                last_used_at: String::new(),
                notes: item
                    .get("notes")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            };

            if ConnectionKind::from_db(&row.kind).is_none() || row.base_url.is_empty() {
                tracing::warn!("skipping import row '{id}': missing required fields");
                continue;
            }
            self.repo.upsert(&row).await?;
            imported += 1;
        }
        Ok(imported)
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        // Delete the keyring entry first; even if the DB delete fails after,
        // the orphaned secret is harmless. Reverse order risks leaving a key
        // in the keyring with no UI to find it.
        if let Err(e) = self.secrets.delete(&connection_account(id)) {
            tracing::warn!("keyring delete failed for {id}: {e}");
        }
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

    pub async fn ping(&self, id: &str) -> AppResult<crate::models::CompletionResult> {
        let row = self.hydrate(self.repo.get(id).await?);
        let cfg = self.http_config().await;
        let _permit = self.permits.acquire().await.expect("semaphore closed");
        providers::ping_with_result(&row, &cfg).await
    }

    pub async fn list_models(&self, id: &str) -> AppResult<Vec<String>> {
        let row = self.hydrate(self.repo.get(id).await?);
        let cfg = self.http_config().await;
        let _permit = self.permits.acquire().await.expect("semaphore closed");
        providers::list_models(&row, &cfg).await
    }

    /// Run a chat completion through a specific connection. Queues behind
    /// `Settings.concurrent_requests` permits — a fifth concurrent call (with
    /// the default of 3) blocks here until one of the in-flight ones returns.
    pub async fn complete(
        &self,
        id: &str,
        messages: Vec<ChatMessage>,
        params: CompletionParams,
    ) -> AppResult<CompletionResult> {
        let row = self.hydrate(self.repo.get(id).await?);
        let cfg = self.http_config().await;
        let _permit = self.permits.acquire().await.expect("semaphore closed");
        let result = providers::complete(&row, messages, params, &cfg).await;
        if result.is_ok() {
            // Stamp recency only on success — a 401 shouldn't bump the
            // connection above working ones in the sort order.
            let _ = self.repo.touch_last_used(id).await;
        }
        result
    }

    /// Raw row access for callers (streaming commands) that need to drive the
    /// HTTP layer directly without going through `complete`. The returned
    /// row has its API key hydrated from the keyring.
    pub async fn get_row(&self, id: &str) -> AppResult<ConnectionRow> {
        Ok(self.hydrate(self.repo.get(id).await?))
    }

    pub async fn get_default_row(&self) -> AppResult<Option<ConnectionRow>> {
        Ok(self.repo.get_default().await?.map(|r| self.hydrate(r)))
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
        let id = row.id.clone();
        let row = self.hydrate(row);
        let cfg = self.http_config().await;
        let _permit = self.permits.acquire().await.expect("semaphore closed");
        let result = providers::complete(&row, messages, params, &cfg).await;
        if result.is_ok() {
            let _ = self.repo.touch_last_used(&id).await;
        }
        result
    }

    /// Exposed for streaming paths that drive the HTTP layer directly so
    /// they can stamp recency after a successful stream completes.
    pub async fn mark_used(&self, id: &str) {
        let _ = self.repo.touch_last_used(id).await;
    }

    /// Borrow a permit for the streaming code path that drives `complete_stream`
    /// directly (`commands::run_prompt_stream` and `overlay::run_stream`).
    /// Returned permit holds the slot until dropped.
    pub async fn acquire_permit(&self) -> tokio::sync::OwnedSemaphorePermit {
        self.permits
            .clone()
            .acquire_owned()
            .await
            .expect("semaphore closed")
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
    // Custom headers, when present, must be a flat JSON object of strings.
    // Validating here means the HTTP layer never has to defend against
    // arbitrary shapes mid-request.
    let h = input.extra_headers.trim();
    if !h.is_empty() {
        let v: serde_json::Value = serde_json::from_str(h)
            .map_err(|e| AppError::Validation(format!("extra headers must be valid JSON: {e}")))?;
        let obj = v
            .as_object()
            .ok_or_else(|| AppError::Validation("extra headers must be a JSON object".into()))?;
        for (name, value) in obj {
            if name.trim().is_empty() {
                return Err(AppError::Validation("extra header name cannot be empty".into()));
            }
            if !value.is_string() {
                return Err(AppError::Validation(format!(
                    "extra header '{name}' must be a string"
                )));
            }
        }
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
        extra_headers: row.extra_headers,
        last_used_at: row.last_used_at,
        notes: row.notes,
    }
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}
