//! Catalog commands — thin IPC adapters over `CatalogService`.

use tauri::{AppHandle, Emitter, State};

use crate::app::AppState;
use crate::models::{ProviderInfo, PromptMode};
use crate::utils::AppError;

#[tauri::command]
pub async fn list_modes(state: State<'_, AppState>) -> Result<Vec<PromptMode>, AppError> {
    state.catalog.list_modes().await
}

#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderInfo>, AppError> {
    state.catalog.list_providers().await
}

#[tauri::command]
pub async fn save_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: PromptMode,
) -> Result<PromptMode, AppError> {
    let saved = state.catalog.save_mode(mode).await?;
    // Signal the tray to rebuild its submenu so the new/edited mode shows
    // up immediately — no restart required.
    let _ = app.emit("modes_changed", ());
    Ok(saved)
}

#[tauri::command]
pub async fn delete_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    state.catalog.delete_mode(&id).await?;
    let _ = app.emit("modes_changed", ());
    Ok(())
}

#[tauri::command]
pub async fn reorder_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    direction: String,
) -> Result<(), AppError> {
    state.catalog.reorder_mode(&id, &direction).await?;
    let _ = app.emit("modes_changed", ());
    Ok(())
}
