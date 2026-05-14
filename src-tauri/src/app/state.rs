//! `AppState` — the single container registered with Tauri's managed state.
//! Holds the process config plus the four wired services. Cheap to clone
//! (every field is `Clone` and internally `Arc`-backed or a pool handle).

use crate::config::Config;
use crate::services::{CatalogService, HistoryService, SettingsService, ShortcutService};

#[derive(Clone)]
#[allow(dead_code)]
pub struct AppState {
    pub config: Config,
    pub settings: SettingsService,
    pub history: HistoryService,
    pub shortcuts: ShortcutService,
    pub catalog: CatalogService,
}
