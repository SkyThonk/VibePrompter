//! Catalog commands — thin IPC adapters over `CatalogService`.

use tauri::State;

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
