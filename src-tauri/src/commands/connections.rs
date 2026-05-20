//! Connection commands — CRUD plus the working-call paths the UI needs.

use tauri::{AppHandle, Emitter, State};

use crate::app::AppState;
use crate::models::{
    ChatMessage, CompletionParams, CompletionResult, ConnectionInfo, ConnectionInput,
    NewHistoryItem,
};
use crate::utils::AppError;

#[tauri::command]
pub async fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionInfo>, AppError> {
    state.connections.list().await
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> Result<ConnectionInfo, AppError> {
    state.connections.save(input).await
}

#[tauri::command]
pub async fn delete_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    state.connections.delete(&id).await
}

#[tauri::command]
pub async fn set_default_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    state.connections.set_default(&id).await
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<CompletionResult, AppError> {
    let result = state.connections.ping(&id).await;
    state.analytics.record(
        "connection_test",
        serde_json::json!({
            "id": id,
            "ok": result.is_ok(),
            "model": result.as_ref().ok().map(|r| r.model.clone()),
            "latencyMs": result.as_ref().ok().map(|r| r.latency_ms),
            "error": result.as_ref().err().map(|e| e.to_string()),
        }),
    );
    result
}

#[tauri::command]
pub async fn list_connection_models(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<String>, AppError> {
    state.connections.list_models(&id).await
}

#[tauri::command]
pub async fn complete(
    state: State<'_, AppState>,
    id: String,
    messages: Vec<ChatMessage>,
    params: Option<CompletionParams>,
) -> Result<CompletionResult, AppError> {
    state
        .connections
        .complete(&id, messages, params.unwrap_or_default())
        .await
}

/// Run a completion through whichever connection is marked default. Errors
/// clearly when nothing is configured so the UI can prompt the user to add
/// a connection rather than surfacing a generic 401.
#[tauri::command]
pub async fn complete_default(
    state: State<'_, AppState>,
    messages: Vec<ChatMessage>,
    params: Option<CompletionParams>,
) -> Result<CompletionResult, AppError> {
    state
        .connections
        .complete_default(messages, params.unwrap_or_default())
        .await
}

/// Run a prompt: pick a mode (for system prompt + temp + max tokens), pass
/// `input` as the user message, run through the requested connection (or the
/// default), and record the run to history. This is the surface the main
/// window's "Run prompt" widget and the future global-hotkey path call.
#[tauri::command]
pub async fn run_prompt(
    state: State<'_, AppState>,
    mode_id: String,
    input: String,
    connection_id: Option<String>,
) -> Result<CompletionResult, AppError> {
    state
        .prompts
        .run(&mode_id, &input, connection_id.as_deref())
        .await
}

/// Streaming variant of `run_prompt`. Emits `stream:{streamId}:token` events
/// with each delta and `stream:{streamId}:done` with the final result. The
/// frontend listens to both. Records to history once complete.
#[tauri::command]
pub async fn run_prompt_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
    mode_id: String,
    input: String,
    connection_id: Option<String>,
) -> Result<(), AppError> {
    if input.trim().is_empty() {
        return Err(AppError::Validation("input text is empty".into()));
    }

    let modes = state.catalog.list_modes().await?;
    let mode = modes
        .iter()
        .find(|m| m.id == mode_id)
        .ok_or_else(|| AppError::NotFound { entity: "prompt_mode", id: mode_id.clone() })?
        .clone();

    let resolved = connection_id
        .clone()
        .or_else(|| mode.provider_override.clone().filter(|s| !s.is_empty()));

    let row = match resolved.as_deref() {
        Some(id) => state.connections.get_row(id).await?,
        None => state
            .connections
            .get_default_row()
            .await?
            .ok_or_else(|| AppError::Validation("no default connection configured".into()))?,
    };

    let messages = vec![crate::models::ChatMessage {
        role: "user".into(),
        content: input.clone(),
    }];
    let params = crate::models::CompletionParams {
        model: None,
        temperature: Some(mode.temperature),
        max_tokens: Some(mode.max_tokens as u32),
        system: Some(crate::services::prompt_template::render(
            &mode.system_prompt,
            &mode.variables,
        )),
    };

    let token_event = format!("stream:{stream_id}:token");
    let done_event = format!("stream:{stream_id}:done");
    let err_event = format!("stream:{stream_id}:error");

    // Register a cancellation flag so the frontend's `cancel_stream` command
    // can flip it mid-flight. Forget on the way out so the map stays bounded.
    let registry = tauri::Manager::state::<crate::app::cancel::CancelRegistry>(&app);
    let cancel_flag = registry.register(&stream_id);
    let cancel_check = cancel_flag.clone();

    let cfg = state.connections.http_config().await;
    let _permit = state.connections.acquire_permit().await;
    let app_for_tokens = app.clone();
    let result = crate::providers::complete_stream(
        &row,
        messages,
        params,
        &cfg,
        move |delta| {
            let _ = app_for_tokens.emit(&token_event, delta);
        },
        move || cancel_check.load(std::sync::atomic::Ordering::SeqCst),
    )
    .await;
    tauri::Manager::state::<crate::app::cancel::CancelRegistry>(&app).forget(&stream_id);
    let was_cancelled = cancel_flag.load(std::sync::atomic::Ordering::SeqCst);

    match result {
        Ok(r) => {
            if was_cancelled {
                // Distinct event so the UI can render "Cancelled" instead of
                // a fake success — but still persist the partial result so
                // the user can copy what was generated before they cancelled.
                let _ = app.emit(&err_event, "cancelled");
            } else {
                let _ = app.emit(&done_event, &r);
                // Stamp recency only on a full success — partial cancelled
                // streams aren't a real "I used this provider" signal.
                state.connections.mark_used(&row.id).await;
            }
            let provider_label = format!("{} · {}", row.label, r.model);
            let cost_micros = crate::services::pricing::cost_micros(
                &r.model,
                r.usage.input_tokens as i64,
                r.usage.output_tokens as i64,
            );
            let _ = state
                .history
                .record(NewHistoryItem {
                    mode_name: mode.name,
                    icon_name: mode.icon_name,
                    provider_label,
                    source_text: input,
                    output_text: r.text,
                    latency_ms: r.latency_ms as i64,
                    input_tokens: r.usage.input_tokens as i64,
                    output_tokens: r.usage.output_tokens as i64,
                    cost_micros,
                })
                .await;
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(&err_event, e.to_string());
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn export_connections(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    state.connections.export_all().await
}

#[tauri::command]
pub async fn import_connections(
    state: State<'_, AppState>,
    payload: serde_json::Value,
    overwrite: Option<bool>,
) -> Result<usize, AppError> {
    state
        .connections
        .import_all(payload, overwrite.unwrap_or(false))
        .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightStats {
    pub in_flight: u32,
    pub capacity: u32,
}

/// Snapshot of the concurrent-request semaphore. Dashboard polls this on a
/// slow timer so the user sees their concurrency cap pushed back when they
/// fire many prompts at once.
#[tauri::command]
pub async fn get_in_flight(state: State<'_, AppState>) -> Result<InFlightStats, AppError> {
    Ok(InFlightStats {
        in_flight: state.connections.in_flight(),
        capacity: state.connections.permits_capacity(),
    })
}

/// Cancel an in-flight stream. Idempotent — calling with an unknown id is a
/// no-op (covers the race where the stream finished before the cancel arrived).
#[tauri::command]
pub async fn cancel_stream(app: AppHandle, stream_id: String) -> Result<(), AppError> {
    tauri::Manager::state::<crate::app::cancel::CancelRegistry>(&app).cancel(&stream_id);
    Ok(())
}
