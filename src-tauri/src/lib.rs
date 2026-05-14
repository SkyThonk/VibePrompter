//! VibePrompter backend library crate.

mod app;
mod commands;
mod config;
mod events;
mod models;
mod services;
mod storage;
mod utils;

// Stub modules — populated by later sub-projects.
mod clipboard;
mod overlay;
mod prompts;
mod providers;
mod security;
mod shortcuts;
mod tray;

use config::Config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging is initialized as early as possible. The bootstrap config is
    // resolved from a temp dir only to obtain a log directory before Tauri's
    // path API is available; `app::setup` later resolves the real app-data
    // config used by the rest of the backend.
    let bootstrap_dir = std::env::temp_dir().join("vibeprompter-bootstrap");
    let _log_guard = Config::from_app_data_dir(&bootstrap_dir)
        .map(|cfg| app::logging::init(&cfg))
        .ok();

    tauri::Builder::default()
        .setup(|app| {
            tauri::async_runtime::block_on(app::setup::initialize(app)).map_err(|err| {
                tracing::error!("backend initialization failed: {err}");
                Box::new(err) as Box<dyn std::error::Error>
            })
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_history,
            commands::clear_history,
            commands::list_shortcuts,
            commands::register_shortcut,
            commands::unregister_shortcut,
            commands::list_modes,
            commands::list_providers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
