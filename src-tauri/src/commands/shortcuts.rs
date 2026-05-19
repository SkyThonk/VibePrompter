//! Shortcut commands — thin IPC adapters over `ShortcutService`.

use serde::Serialize;
use tauri::State;

use crate::app::AppState;
use crate::models::{ShortcutConfig, ShortcutItem};
use crate::utils::AppError;

#[derive(Debug, Serialize)]
pub struct ShortcutBinding {
    pub id: String,
    pub action: String,
    pub accelerator: String,
    /// True when the action has a backend dispatch — `mode_switch` and
    /// `open_palette` today; the rest are dormant until sub-project 2 lands.
    #[serde(rename = "hasBackend")]
    pub has_backend: bool,
}

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

/// List shortcuts paired with their backend implementation status. Frontend
/// uses this to render "live binding" indicators in the Shortcuts settings
/// panel and to surface which actions are still wired only at the DB layer.
#[tauri::command]
pub async fn list_global_shortcuts(
    state: State<'_, AppState>,
) -> Result<Vec<ShortcutBinding>, AppError> {
    let items = state.shortcuts.list().await?;
    Ok(items
        .into_iter()
        .filter(|i| i.enabled)
        .map(|i| ShortcutBinding {
            has_backend: matches!(
                i.action.as_str(),
                "mode_switch"
                    | "open_palette"
                    | "rewrite_selection"
                    | "fix_grammar"
                    | "summarize"
            ),
            id: i.id,
            action: i.action,
            accelerator: i.accelerator,
        })
        .collect())
}
