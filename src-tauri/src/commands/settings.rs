//! Settings commands — thin IPC adapters over `SettingsService`.

use tauri::State;

use crate::app::AppState;
use crate::models::Settings;
use crate::utils::AppError;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, AppError> {
    state.settings.get().await
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), AppError> {
    state.settings.save(&settings).await
}
