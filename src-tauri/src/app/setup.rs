//! Composition root. Builds `Config` → `SqlitePool` → `EventBus` → repositories
//! → services → `AppState`, runs migrations, registers managed state, and emits
//! `app_ready`. Called from `lib.rs` inside the Tauri `setup` hook.

use tauri::{App, AppHandle, Emitter, Listener, Manager, WindowEvent};

use crate::app::state::AppState;
use crate::config::Config;
use crate::events::{AppEvent, EventBus};
use crate::services::{
    CatalogService, ConnectionService, HistoryService, PromptService, SettingsService,
    ShortcutService,
};
use crate::storage::repositories::{
    ConnectionRepo, HistoryRepo, ModeRepo, ProviderRepo, SettingsRepo, ShortcutRepo,
};
use crate::storage::{create_pool, run_migrations};
use crate::utils::{AppError, AppResult};

/// Build and register all backend state. Runs on the Tauri setup hook.
pub async fn initialize(app: &App) -> AppResult<()> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Config(format!("cannot resolve app data dir: {e}")))?;
    std::fs::create_dir_all(&app_data_dir)?;

    let config = Config::from_app_data_dir(&app_data_dir)?;
    tracing::info!("app data dir: {}", config.app_data_dir.display());

    let pool = create_pool(&config.db_path).await?;
    run_migrations(&pool).await?;
    tracing::info!("database ready at {}", config.db_path.display());

    let events = EventBus::new(app.handle().clone());

    let settings = SettingsService::new(SettingsRepo::new(pool.clone()), events.clone());
    let history = HistoryService::new(HistoryRepo::new(pool.clone()));
    let shortcuts = ShortcutService::new(ShortcutRepo::new(pool.clone()), events.clone());
    let catalog = CatalogService::new(ModeRepo::new(pool.clone()), ProviderRepo::new(pool.clone()));
    let connections = ConnectionService::new(ConnectionRepo::new(pool.clone()));
    let prompts = PromptService::new(catalog.clone(), connections.clone(), history.clone());

    // Hydrate the tray's mode list from the catalog *before* moving `catalog`
    // into AppState. Falls back to a minimal default if the seed is missing
    // for any reason — better to ship a tray than silently disable OS pieces.
    let tray_modes: Vec<crate::tray::TrayMode> = match catalog.list_modes().await {
        Ok(modes) if !modes.is_empty() => modes
            .into_iter()
            .map(|m| crate::tray::TrayMode {
                id: m.id,
                name: m.name,
                icon_name: Some(m.icon_name),
            })
            .collect(),
        Ok(_) => {
            tracing::warn!("catalog returned no modes — falling back to default tray entry");
            vec![crate::tray::TrayMode {
                id: "developer".into(),
                name: "Developer".into(),
                icon_name: None,
            }]
        }
        Err(e) => return Err(e),
    };

    // Restore last-active mode id (set by `tray::cycle_mode`). Done before
    // AppState moves so we can read from `settings` here. If the persisted
    // id is no longer in the catalog (seed changed, user uninstalled a
    // custom mode), drop the stale value so we don't keep retrying.
    let initial_mode_id = {
        let stored = settings
            .get_kv("active_mode_id")
            .await
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str::<String>(&v).ok());
        match stored {
            Some(id) if tray_modes.iter().any(|m| m.id == id) => Some(id),
            Some(stale) => {
                tracing::info!("dropping stale active_mode_id '{stale}' — not in catalog");
                let _ = settings.set_kv("active_mode_id", "null").await;
                None
            }
            None => None,
        }
    };

    // Pull the current accelerator labels for the tray menu so the hints
    // displayed there match what the user has configured in Settings rather
    // than a hardcoded literal.
    let shortcut_items = shortcuts.list().await.unwrap_or_default();
    let find_accel = |action: &str| {
        shortcut_items
            .iter()
            .find(|s| s.action == action && s.enabled)
            .map(|s| s.accelerator.clone())
    };
    let tray_accels = crate::tray::TrayAccelerators {
        palette: find_accel("open_palette"),
        mode_switch: find_accel("mode_switch"),
    };

    app.manage(AppState { config, settings, history, shortcuts, catalog, connections, prompts });

    // OS integrations — tray icon, then global shortcut (which depends on
    // `TrayState` being managed because it calls back into `tray::cycle_mode`).
    let handle = app.handle().clone();
    crate::tray::init(&handle, tray_modes, initial_mode_id.as_deref(), tray_accels)?;

    // Echo the initial active mode so any frontend that mounted before the
    // tray finished initializing (race on cold start) still receives state
    // via the same `mode_changed` event everything else listens to.
    if let Some(state) = handle.try_state::<crate::tray::TrayState>() {
        let m = state.current();
        let _ = handle.emit(
            "mode_changed",
            serde_json::json!({ "id": m.id, "name": m.name, "iconName": m.icon_name }),
        );
    }
    if let Err(e) = crate::shortcuts::init(&handle).await {
        tracing::warn!("global shortcut init failed (non-fatal): {e}");
    }

    // Re-register all global shortcuts when the user edits a binding in
    // Settings. The shortcut service emits this on every register/unregister.
    let handle_for_shortcuts = handle.clone();
    handle.listen("shortcut_updated", move |_event| {
        let h = handle_for_shortcuts.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::shortcuts::init(&h).await {
                tracing::warn!("shortcut re-registration failed: {e}");
            }
        });
    });

    // Close-to-tray: intercept the main window's close button and hide the
    // window instead of letting Tauri tear down the process. The user quits
    // explicitly via the tray menu's "Quit" item. This matches how Slack,
    // Discord, Raycast on Windows behave — the app stays resident so the
    // global hotkey keeps working.
    // If we were launched by the OS at login (autostart plugin passed
    // `--autostart` in argv), hide the main window so we sit in the tray.
    // Manual launches keep the window visible — same UX as Slack/Discord.
    let launched_via_autostart = std::env::args().any(|a| a == "--autostart");
    if launched_via_autostart {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
            tracing::info!("auto-launched — main window hidden to tray");
        }
    }

    if let Some(main_window) = app.get_webview_window("main") {
        let win = main_window.clone();
        let handle_for_event = handle.clone();
        main_window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Honor the user's `quit_on_close` preference. Default
                // behavior is hide-to-tray (matches Slack, Discord, Raycast on
                // Windows); when the user explicitly opted into quit-on-close
                // in Settings, the close button quits the process.
                let s = read_settings_sync(&handle_for_event);
                if s.as_ref().map(|s| s.quit_on_close).unwrap_or(false) {
                    handle_for_event.exit(0);
                } else {
                    api.prevent_close();
                    let _ = win.hide();
                    // First-time hint: most users don't expect close-to-tray
                    // and start wondering why the process is still running.
                    // We flash the HUD once with a clear message; subsequent
                    // closes stay silent so we don't nag.
                    show_tray_hint_once(&handle_for_event);
                }
            }
            // Tauri 2 has no dedicated "Minimized" event, but a minimize
            // arrives as a Resized to (0, 0). When `minimize_to_tray` is on,
            // we react by hiding the window — the taskbar entry disappears
            // and the tray icon becomes the only re-entry point.
            WindowEvent::Resized(size) if size.width == 0 && size.height == 0 => {
                let want_hide = read_settings_sync(&handle_for_event)
                    .map(|s| s.minimize_to_tray)
                    .unwrap_or(true);
                if want_hide {
                    let _ = win.hide();
                    // Un-minimize so the next `show()` doesn't restore as
                    // minimized — otherwise the user sees the window flash
                    // into the taskbar momentarily.
                    let _ = win.unminimize();
                }
            }
            _ => {}
        });
    }

    // Reconcile OS autostart + apply history retention on every launch, then
    // re-run on each `settings_changed` so toggling the Settings UI takes
    // effect immediately without a restart.
    let state_clone = app.state::<crate::app::state::AppState>().inner().clone();
    let handle_for_boot = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(s) = state_clone.settings.get().await {
            apply_autostart(&handle_for_boot, s.boot_start);
            apply_devtools(&handle_for_boot, s.dev_tools);
            let _ = state_clone.history.enforce_retention(&s.history_retention).await;
        }
    });

    let handle_for_listener = handle.clone();
    handle.listen("settings_changed", move |_event| {
        let h = handle_for_listener.clone();
        let state = h.state::<crate::app::state::AppState>().inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(s) = state.settings.get().await {
                apply_autostart(&h, s.boot_start);
                apply_devtools(&h, s.dev_tools);
                // If the user disabled notifications while the HUD is on
                // screen, hide it immediately — otherwise the in-flight
                // fade still completes and contradicts what they just set.
                if !s.notifications {
                    if let Some(hud) = h.get_webview_window("mode-hud") {
                        let _ = hud.hide();
                    }
                }
                let _ = state.history.enforce_retention(&s.history_retention).await;
            }
        });
    });

    events.emit(AppEvent::AppReady);
    tracing::info!("backend initialized");
    Ok(())
}

/// Synchronously fetch the full `Settings` aggregate from inside a Tauri
/// window-event callback (the callback runs on the main thread, so we cross
/// into the async runtime just for this one read). Returns `None` if state
/// isn't yet managed or the DB read fails — callers must define their own
/// fallback for that case.
fn read_settings_sync(app: &AppHandle) -> Option<crate::models::Settings> {
    let state = app.try_state::<crate::app::state::AppState>()?;
    let svc = state.settings.clone();
    match tauri::async_runtime::block_on(svc.get()) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("sync settings read failed: {e}");
            None
        }
    }
}

/// Show the close-to-tray hint via the HUD once per install. Stores a
/// `tray_hint_shown` flag in the settings KV so it never nags the user twice.
fn show_tray_hint_once(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::app::state::AppState>() else {
        return;
    };
    let svc = state.settings.clone();
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let already = svc.get_kv("tray_hint_shown").await.ok().flatten().is_some();
        if already {
            return;
        }
        let _ = svc.set_kv("tray_hint_shown", "true").await;
        let _ = crate::commands::overlay::show_mode_hud_internal(
            app_for_task,
            crate::commands::overlay::ModeHudArgs {
                mode_id: "tray-hint".into(),
                mode_name: "VibePrompter".into(),
                icon_name: Some("bell".into()),
                kicker: Some("Still running in tray".into()),
            },
        );
    });
}

/// Open or close the main window's devtools according to the user's
/// preference. Only effective in dev builds (or release builds compiled with
/// the `tauri/devtools` feature) — Tauri compiles `open_devtools` /
/// `close_devtools` out otherwise, so this becomes a no-op in production.
fn apply_devtools(app: &AppHandle, want_open: bool) {
    #[cfg(debug_assertions)]
    if let Some(win) = app.get_webview_window("main") {
        if want_open {
            win.open_devtools();
        } else {
            win.close_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, want_open); // silence unused warnings in release
    }
}

/// Reconcile the OS autostart entry with the user's preference. Idempotent —
/// safe to call on every settings change and at every boot.
fn apply_autostart(app: &AppHandle, want_enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let is_enabled = mgr.is_enabled().unwrap_or(false);
    if want_enabled && !is_enabled {
        if let Err(e) = mgr.enable() {
            tracing::warn!("autostart enable failed: {e}");
        } else {
            tracing::info!("autostart enabled");
        }
    } else if !want_enabled && is_enabled {
        if let Err(e) = mgr.disable() {
            tracing::warn!("autostart disable failed: {e}");
        } else {
            tracing::info!("autostart disabled");
        }
    }
}
