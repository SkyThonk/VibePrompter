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

/// Atomic first-run decision: returns `true` exactly once per installation
/// (the very first time it's called) and persists the flag in the same call
/// so subsequent launches always return `false`.
///
/// Returns `false` for fresh installs whose data dir was carried over from a
/// previous setup (any existing connection rows count as evidence onboarding
/// happened already — self-heal in case the flag was never written).
///
/// Doing the read + write inside one backend call means the frontend can't
/// loop onboarding even if the user kills the window the instant `/setup`
/// renders: the flag is durable on disk *before* the redirect happens.
#[tauri::command]
pub async fn check_first_run(state: State<'_, AppState>) -> Result<bool, AppError> {
    if state.settings.get_kv("first_run_done").await?.is_some() {
        return Ok(false);
    }
    let has_connections = !state.connections.list().await?.is_empty();
    state.settings.set_kv("first_run_done", "true").await?;
    Ok(!has_connections)
}

/// Generic KV read/write — used by the frontend for ephemeral state that
/// doesn't belong on the typed `Settings` aggregate (e.g. `last_route`).
/// Whitelisted to a small key prefix so a compromised frontend can't write
/// arbitrary rows into the settings table.
const KV_ALLOWED_KEYS: &[&str] = &["last_route", "last_seen_version"];

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

/// Export the user's full Settings aggregate as JSON. Wraps it with a schema
/// tag so the import side can refuse files from other apps.
#[tauri::command]
pub async fn export_settings(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let settings = state.settings.get().await?;
    Ok(serde_json::json!({
        "schema": "vibeprompter-settings-v1",
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "settings": settings,
    }))
}

/// Import a previously-exported Settings payload. Unknown fields are
/// silently dropped (Settings::default fills the gaps) so a file from a
/// future version with new fields downgrades gracefully.
#[tauri::command]
pub async fn import_settings(
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), AppError> {
    let schema = payload.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    if schema != "vibeprompter-settings-v1" {
        return Err(AppError::Validation(format!(
            "unrecognized settings schema '{schema}' — expected vibeprompter-settings-v1"
        )));
    }
    let value = payload
        .get("settings")
        .cloned()
        .ok_or_else(|| AppError::Validation("payload missing `settings` object".into()))?;
    let settings: crate::models::Settings = serde_json::from_value(value).map_err(|e| {
        AppError::Validation(format!("settings payload doesn't match expected shape: {e}"))
    })?;
    state.settings.save(&settings).await
}
