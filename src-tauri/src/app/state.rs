//! `AppState` — the single container registered with Tauri's managed state.
//! Holds the process config plus the four wired services. Cheap to clone
//! (every field is `Clone` and internally `Arc`-backed or a pool handle).

use crate::config::Config;
use crate::services::{
    CatalogService, ConnectionService, HistoryService, PromptService, SettingsService,
    ShortcutService,
};

#[derive(Clone)]
pub struct AppState {
    /// Stored for sub-projects 2/3 (path resolution etc.); no Foundation command reads it yet.
    #[allow(dead_code)]
    pub config: Config,
    pub settings: SettingsService,
    pub history: HistoryService,
    pub shortcuts: ShortcutService,
    pub catalog: CatalogService,
    pub connections: ConnectionService,
    pub prompts: PromptService,
}
