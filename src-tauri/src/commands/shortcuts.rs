//! Shortcut commands — thin IPC adapters over `ShortcutService`.

use tauri::State;

use crate::app::AppState;
use crate::models::{ShortcutConfig, ShortcutItem};
use crate::utils::AppError;

#[tauri::command]
pub async fn list_shortcuts(state: State<'_, AppState>) -> Result<Vec<ShortcutItem>, AppError> {
    state.shortcuts.list().await
}

#[tauri::command]
pub async fn register_shortcut(
    state: State<'_, AppState>,
    config: ShortcutConfig,
) -> Result<(), AppError> {
    state.shortcuts.register(config).await
}

#[tauri::command]
pub async fn unregister_shortcut(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    state.shortcuts.unregister(&id).await
}
