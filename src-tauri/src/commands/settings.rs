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

/// Has the first-run onboarding been completed? Stored as a KV flag so the
/// frontend can decide whether to land on `/setup` or `/` at startup without
/// polluting the typed `Settings` aggregate.
#[tauri::command]
pub async fn get_first_run_done(state: State<'_, AppState>) -> Result<bool, AppError> {
    Ok(state.settings.get_kv("first_run_done").await?.is_some())
}

#[tauri::command]
pub async fn mark_first_run_done(state: State<'_, AppState>) -> Result<(), AppError> {
    state.settings.set_kv("first_run_done", "true").await
}

/// Generic KV read/write — used by the frontend for ephemeral state that
/// doesn't belong on the typed `Settings` aggregate (e.g. `last_route`).
/// Whitelisted to a small key prefix so a compromised frontend can't write
/// arbitrary rows into the settings table.
const KV_ALLOWED_KEYS: &[&str] = &["last_route"];

fn ensure_allowed(key: &str) -> Result<(), AppError> {
    if KV_ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "kv key '{key}' is not in the frontend allow-list"
        )))
    }
}

#[tauri::command]
pub async fn get_kv(state: State<'_, AppState>, key: String) -> Result<Option<String>, AppError> {
    ensure_allowed(&key)?;
    state.settings.get_kv(&key).await
}

#[tauri::command]
pub async fn set_kv(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    ensure_allowed(&key)?;
    state.settings.set_kv(&key, &value).await
}
