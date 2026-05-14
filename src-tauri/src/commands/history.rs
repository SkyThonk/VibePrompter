//! History commands — thin IPC adapters over `HistoryService`.

use tauri::State;

use crate::app::AppState;
use crate::models::{HistoryItem, HistoryQuery};
use crate::utils::AppError;

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    query: Option<HistoryQuery>,
) -> Result<Vec<HistoryItem>, AppError> {
    state.history.list(query.unwrap_or_default()).await
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> Result<u64, AppError> {
    state.history.clear().await
}
