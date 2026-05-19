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
        // Single-instance must register first so subsequent launches are
        // intercepted before any other plugin / setup work runs. The callback
        // surfaces the existing main window — same behavior as Slack/Discord
        // when the user re-clicks the desktop shortcut.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tracing::info!("second launch intercepted — focusing existing window");
            crate::tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // Persist window size/position across launches so the user's layout
        // sticks. Skips the `mode-hud` window — that's transparent, sized
        // by config, and re-centered on every show.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label != "mode-hud")
                // Only restore geometry. The plugin's default includes
                // Decorations, which would clobber `decorations: false` in
                // tauri.conf.json on every launch after an older build saved
                // state with native chrome enabled.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        // Pass `--autostart` to the OS-registered launcher so we can detect
        // auto-launched starts and hide the main window — keeps the app in
        // the tray on login instead of stealing focus on every reboot.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            tauri::async_runtime::block_on(app::setup::initialize(app)).map_err(|err| {
                tracing::error!("backend initialization failed: {err}");
                Box::new(err) as Box<dyn std::error::Error>
            })
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_first_run_done,
            commands::mark_first_run_done,
            commands::get_kv,
            commands::set_kv,
            commands::export_settings,
            commands::import_settings,
            commands::get_history,
            commands::clear_history,
            commands::export_history,
            commands::count_history,
            commands::set_history_favorite,
            commands::export_connections,
            commands::import_connections,
            commands::list_shortcuts,
            commands::register_shortcut,
            commands::unregister_shortcut,
            commands::list_global_shortcuts,
            commands::list_modes,
            commands::save_mode,
            commands::delete_mode,
            commands::list_providers,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::set_default_connection,
            commands::test_connection,
            commands::list_connection_models,
            commands::complete,
            commands::complete_default,
            commands::run_prompt,
            commands::run_prompt_stream,
            commands::cancel_stream,
            commands::get_in_flight,
            commands::get_diagnostics,
            commands::get_recent_logs,
            commands::run_health_check,
            commands::get_analytics_summary,
            commands::open_app_folder,
            commands::show_mode_hud,
            commands::cycle_mode_cmd,
            commands::set_active_mode,
            commands::get_active_mode,
            commands::quit_app,
            commands::hide_main_window,
            commands::refine_begin,
            commands::refine_accept,
            commands::refine_reject,
            commands::refine_retry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
