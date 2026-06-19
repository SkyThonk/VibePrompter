//! Prompt execution — composes a `PromptMode` with the default
//! `ConnectionService` to actually run a completion, then records the
//! transaction to history.
//!
//! This is the one place that knows the end-to-end shape: mode → connection
//! → completion → history. Commands stay thin.

use crate::models::{ChatMessage, CompletionParams, CompletionResult, NewHistoryItem};
use crate::services::{AnalyticsService, CatalogService, ConnectionService, HistoryService};
use crate::storage::repositories::ConnectionRow;
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct PromptService {
    catalog: CatalogService,
    connections: ConnectionService,
    history: HistoryService,
    analytics: Option<AnalyticsService>,
}

impl PromptService {
    pub fn new(
        catalog: CatalogService,
        connections: ConnectionService,
        history: HistoryService,
    ) -> Self {
        Self { catalog, connections, history, analytics: None }
    }

    pub fn with_analytics(mut self, a: AnalyticsService) -> Self {
        self.analytics = Some(a);
        self
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
            system: Some(crate::services::prompt_template::render(
                &mode.system_prompt,
                &mode.variables,
            )),
        };

        // Precedence: explicit `connection_id` arg → mode's `provider_override`
        // → workspace default. So a mode can pin itself to a specific
        // connection ("Code Review always uses Claude") while one-off calls
        // can still target a different connection from the UI.
        let resolved_conn_id = connection_id
            .map(|s| s.to_string())
            .or_else(|| mode.provider_override.clone().filter(|s| !s.is_empty()));

        let result = match resolved_conn_id.as_deref() {
            Some(id) => self.connections.complete(id, messages, params).await?,
            None => self.connections.complete_default(messages, params).await?,
        };

        // Best-effort history insert — the user still gets the response even
        // if history write fails (e.g. disk full). The error is logged for
        // diagnostics rather than propagated.
        let all_conns = self.connections.list().await.unwrap_or_default();
        let provider_label = describe_connection(
            all_conns.clone(),
            resolved_conn_id.as_deref(),
            &result.model,
        );
        // Look up the resolved connection's pricing overrides; fall back to
        // 0/0 (= use the embedded table) when no connection was resolved or
        // the row carries no override.
        let (price_in, price_out) = resolved_conn_id
            .as_deref()
            .and_then(|id| all_conns.iter().find(|c| c.id == id))
            .map(|c| (c.price_input_per_m, c.price_output_per_m))
            .unwrap_or((0.0, 0.0));
        let cost_micros = crate::services::pricing::cost_micros(
            &result.model,
            result.usage.input_tokens as i64,
            result.usage.output_tokens as i64,
            price_in,
            price_out,
        );
        if let Err(e) = self
            .history
            .record(NewHistoryItem {
                mode_name: mode.name.clone(),
                icon_name: mode.icon_name.clone(),
                provider_label,
                source_text: input.to_string(),
                output_text: result.text.clone(),
                latency_ms: result.latency_ms as i64,
                input_tokens: result.usage.input_tokens as i64,
                output_tokens: result.usage.output_tokens as i64,
                cost_micros,
                parent_id: None,
            })
            .await
        {
            tracing::warn!("history record failed (non-fatal): {e}");
        }

        if let Some(a) = &self.analytics {
            a.record(
                "prompt_run",
                serde_json::json!({
                    "mode": mode.id,
                    "model": result.model,
                    "latencyMs": result.latency_ms,
                    "inputTokens": result.usage.input_tokens,
                    "outputTokens": result.usage.output_tokens,
                }),
            );
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
            system: Some(crate::services::prompt_template::render(
                &mode.system_prompt,
                &mode.variables,
            )),
        },
        // `run_with_row` is a dead-code escape hatch — use default HTTP
        // config; real callers go through `ConnectionService` which threads
        // settings-derived config through.
        &crate::providers::HttpConfig::default(),
    )
    .await?;

    let cost_micros = crate::services::pricing::cost_micros(
        &result.model,
        result.usage.input_tokens as i64,
        result.usage.output_tokens as i64,
        row.price_input_per_m,
        row.price_output_per_m,
    );
    if let Err(e) = history
        .record(NewHistoryItem {
            mode_name: mode.name,
            icon_name: mode.icon_name,
            provider_label: format!("{} · {}", row.label, result.model),
            source_text: input.to_string(),
            output_text: result.text.clone(),
            latency_ms: result.latency_ms as i64,
            input_tokens: result.usage.input_tokens as i64,
            output_tokens: result.usage.output_tokens as i64,
            cost_micros,
            parent_id: None,
        })
        .await
    {
        tracing::warn!("failed to record prompt history: {e}");
    }
    Ok(result)
}
