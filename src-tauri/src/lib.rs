//! VibePrompter backend library crate.

// `Manager` brings `get_webview_window`, `state`, `try_state`, etc. into
// scope on `App` / `AppHandle`. We use it in the setup hook below.
use tauri::Manager;

mod app;
mod commands;
mod config;
mod events;
mod models;
mod services;
mod storage;
mod utils;

mod platform;

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
        .plugin(tauri_plugin_dialog::init())
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
            let init = tauri::async_runtime::block_on(app::setup::initialize(app));
            if let Err(e) = &init {
                // Force-show the main window on initialization failure so the
                // user isn't stuck with a "click app, nothing opens" experience.
                // The main window is `visible: false` by default (so autostart
                // doesn't flash a window) and is normally shown by the setup
                // path on success — that path doesn't run when initialize
                // errors out. Showing it here gives the user a window they can
                // close, plus the log/error path stays the same.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                tracing::error!("backend initialization failed: {e}");
            }
            init.map_err(|err| Box::new(err) as Box<dyn std::error::Error>)
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_first_run_done,
            commands::mark_first_run_done,
            commands::check_first_run,
            commands::get_kv,
            commands::set_kv,
            commands::export_settings,
            commands::import_settings,
            commands::get_history,
            commands::clear_history,
            commands::export_history,
            commands::export_history_to_file,
            commands::count_history,
            commands::set_history_favorite,
            commands::get_cost_summary,
            commands::get_cost_breakdown,
            commands::export_connections,
            commands::import_connections,
            commands::list_shortcuts,
            commands::register_shortcut,
            commands::unregister_shortcut,
            commands::list_global_shortcuts,
            commands::list_modes,
            commands::save_mode,
            commands::delete_mode,
            commands::reorder_mode,
            commands::list_providers,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::set_default_connection,
            commands::test_connection,
            commands::list_connection_models,
            commands::list_models_for_draft,
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
            commands::open_url,
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
            commands::refine_followup,
            commands::refine_switch_connection,
            commands::refine_copy_and_hide,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
