//! Connection commands — CRUD plus the working-call paths the UI needs.

use tauri::State;

use crate::app::AppState;
use crate::models::{
    ChatMessage, CompletionParams, CompletionResult, ConnectionInfo, ConnectionInput,
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
pub async fn test_connection(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.connections.ping(&id).await
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
