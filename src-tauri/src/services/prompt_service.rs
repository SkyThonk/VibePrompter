//! Prompt execution — composes a `PromptMode` with the default
//! `ConnectionService` to actually run a completion, then records the
//! transaction to history.
//!
//! This is the one place that knows the end-to-end shape: mode → connection
//! → completion → history. Commands stay thin.

use crate::models::{ChatMessage, CompletionParams, CompletionResult, NewHistoryItem};
use crate::services::{CatalogService, ConnectionService, HistoryService};
use crate::storage::repositories::ConnectionRow;
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct PromptService {
    catalog: CatalogService,
    connections: ConnectionService,
    history: HistoryService,
}

impl PromptService {
    pub fn new(
        catalog: CatalogService,
        connections: ConnectionService,
        history: HistoryService,
    ) -> Self {
        Self { catalog, connections, history }
    }

    /// Execute a prompt: combine the mode's system prompt with `input`, run
    /// the completion through `connection_id` (or the default), persist a
    /// history entry, and return the result.
    pub async fn run(
        &self,
        mode_id: &str,
        input: &str,
        connection_id: Option<&str>,
    ) -> AppResult<CompletionResult> {
        if input.trim().is_empty() {
            return Err(AppError::Validation("input text is empty".into()));
        }

        let modes = self.catalog.list_modes().await?;
        let mode = modes
            .iter()
            .find(|m| m.id == mode_id)
            .ok_or_else(|| AppError::NotFound {
                entity: "prompt_mode",
                id: mode_id.to_string(),
            })?
            .clone();

        let messages = vec![ChatMessage { role: "user".into(), content: input.to_string() }];
        let params = CompletionParams {
            model: None, // honor the connection's default model
            temperature: Some(mode.temperature),
            max_tokens: Some(mode.max_tokens as u32),
            system: Some(mode.system_prompt.clone()),
        };

        let result = match connection_id {
            Some(id) => self.connections.complete(id, messages, params).await?,
            None => self.connections.complete_default(messages, params).await?,
        };

        // Best-effort history insert — the user still gets the response even
        // if history write fails (e.g. disk full). The error is logged for
        // diagnostics rather than propagated.
        let provider_label = describe_connection(
            self.connections.list().await.unwrap_or_default(),
            connection_id,
            &result.model,
        );
        if let Err(e) = self
            .history
            .record(NewHistoryItem {
                mode_name: mode.name,
                icon_name: mode.icon_name,
                provider_label,
                source_text: input.to_string(),
                output_text: result.text.clone(),
                latency_ms: result.latency_ms as i64,
            })
            .await
        {
            tracing::warn!("history record failed (non-fatal): {e}");
        }

        Ok(result)
    }
}

/// Build the "provider · model" label we store on the history row. Falls back
/// to just the model id when we can't resolve the connection's label.
fn describe_connection(
    connections: Vec<crate::models::ConnectionInfo>,
    requested: Option<&str>,
    model: &str,
) -> String {
    let label = requested
        .and_then(|id| connections.iter().find(|c| c.id == id))
        .or_else(|| connections.iter().find(|c| c.is_default))
        .map(|c| c.label.as_str())
        .unwrap_or("");
    if label.is_empty() {
        model.to_string()
    } else {
        format!("{label} · {model}")
    }
}

// Allow direct callers to feed a `ConnectionRow` (e.g. a future "run with this
// custom connection" UI) without going through the service layer's id lookup.
#[allow(dead_code)]
pub async fn run_with_row(
    catalog: &CatalogService,
    history: &HistoryService,
    row: &ConnectionRow,
    mode_id: &str,
    input: &str,
) -> AppResult<CompletionResult> {
    let modes = catalog.list_modes().await?;
    let mode = modes
        .iter()
        .find(|m| m.id == mode_id)
        .ok_or_else(|| AppError::NotFound {
            entity: "prompt_mode",
            id: mode_id.to_string(),
        })?
        .clone();

    let result = crate::providers::complete(
        row,
        vec![ChatMessage { role: "user".into(), content: input.to_string() }],
        CompletionParams {
            model: None,
            temperature: Some(mode.temperature),
            max_tokens: Some(mode.max_tokens as u32),
            system: Some(mode.system_prompt.clone()),
        },
    )
    .await?;

    let _ = history
        .record(NewHistoryItem {
            mode_name: mode.name,
            icon_name: mode.icon_name,
            provider_label: format!("{} · {}", row.label, result.model),
            source_text: input.to_string(),
            output_text: result.text.clone(),
            latency_ms: result.latency_ms as i64,
        })
        .await;
    Ok(result)
}
