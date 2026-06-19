//! Composition root. Builds `Config` → `SqlitePool` → `EventBus` → repositories
//! → services → `AppState`, runs migrations, registers managed state, and emits
//! `app_ready`. Called from `lib.rs` inside the Tauri `setup` hook.

use tauri::{App, AppHandle, Emitter, Listener, Manager, WindowEvent};

use crate::app::state::AppState;
use crate::config::Config;
use crate::events::{AppEvent, EventBus};
use crate::services::{
    AnalyticsService, CatalogService, ConnectionService, HistoryService, PromptService,
    SettingsService, ShortcutService,
};
use crate::storage::repositories::{
    AnalyticsRepo, ConnectionRepo, HistoryRepo, ModeRepo, ProviderRepo, SettingsRepo,
    ShortcutRepo,
};
use crate::storage::{backup_before_migrations, create_pool, run_migrations};
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
    // Snapshot the DB before applying anything new — non-fatal on failure.
    if let Err(e) = backup_before_migrations(&pool, &config.db_path).await {
        tracing::warn!("backup_before_migrations: {e}");
    }
    run_migrations(&pool).await?;
    tracing::info!("database ready at {}", config.db_path.display());

    let events = EventBus::new(app.handle().clone());

    let settings = SettingsService::new(SettingsRepo::new(pool.clone()), events.clone());
    let history = HistoryService::with_events(HistoryRepo::new(pool.clone()), events.clone());
    let shortcuts = ShortcutService::new(ShortcutRepo::new(pool.clone()), events.clone());
    let catalog = CatalogService::new(ModeRepo::new(pool.clone()), ProviderRepo::new(pool.clone()));
    let keyring_available = crate::security::KeyringStore::new().is_available();
    let secrets: std::sync::Arc<dyn crate::security::SecretStore> =
        crate::security::init().into();
    // Concurrent outbound-LLM-call cap. Used to be user-tunable but the
    // realistic max in any UI flow is ~3 (overlay stream + a Settings Test
    // + a Fetch models). A fixed 4 is enough headroom for the legitimate
    // case and small enough to act as a defensive guard against a bug
    // firing dozens of parallel requests.
    let connections = ConnectionService::new(
        ConnectionRepo::new(pool.clone()),
        secrets.clone(),
        settings.clone(),
        4,
    );
    // One-shot migration: move any plaintext keys from older builds into the
    // OS keyring. Idempotent — rows with empty `api_key` are skipped.
    if let Err(e) = connections.migrate_keys_to_keyring().await {
        tracing::warn!("keyring migration failed (non-fatal): {e}");
    }
    let analytics = AnalyticsService::new(AnalyticsRepo::new(pool.clone()));
    let prompts = PromptService::new(catalog.clone(), connections.clone(), history.clone())
        .with_analytics(analytics.clone());

    // Hydrate the tray's mode list from the catalog *before* moving `catalog`
    // into AppState. Falls back to a minimal default if the seed is missing
    // for any reason — better to ship a tray than silently disable OS pieces.
    // Built-in (`is_system`) modes are filtered out — Grammar / Summarize have
    // dedicated global shortcuts (Ctrl+Alt+G / Ctrl+Alt+S) that route straight
    // to the refine overlay, so putting them in the tray submenu and cycle
    // rotation would confuse users about what the active-mode rewrite does.
    let tray_modes: Vec<crate::tray::TrayMode> = match catalog.list_modes().await {
        Ok(modes) if modes.iter().any(|m| m.enabled && !m.is_system) => modes
            .into_iter()
            .filter(|m| m.enabled && !m.is_system)
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

    app.manage(AppState {
        config,
        settings,
        history,
        shortcuts,
        catalog,
        connections,
        prompts,
        analytics: analytics.clone(),
        keyring_available,
    });
    // Audit-trail event: app finished initializing. Single event_type per
    // session-start lets us compute uptime/restart cadence from the table.
    analytics.record(
        "app_start",
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
        }),
    );
    app.manage(crate::app::cancel::CancelRegistry::new());

    // OS integrations — tray icon, then global shortcut (which depends on
    // `TrayState` being managed because it calls back into `tray::cycle_mode`).
    let handle = app.handle().clone();
    crate::tray::init(&handle, tray_modes, initial_mode_id.as_deref(), tray_accels)?;
    crate::overlay::init(&handle);

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

    // Rebuild the tray menu whenever the mode catalog changes so a new mode
    // shows up in the "Set mode" submenu immediately.
    let handle_for_modes = handle.clone();
    handle.listen("modes_changed", move |_event| {
        let h = handle_for_modes.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::tray::rebuild_modes(&h).await {
                tracing::warn!("tray rebuild_modes failed: {e}");
            }
        });
    });

    // Close-to-tray: intercept the main window's close button and hide the
    // window instead of letting Tauri tear down the process. The user quits
    // explicitly via the tray menu's "Quit" item. This matches how Slack,
    // Discord, Raycast on Windows behave — the app stays resident so the
    // global hotkey keeps working.
    // If we were launched by the OS at login, hide the main window so we sit in
    // the tray. Two launch paths, two signals:
    //   * Registry autostart (non-Store builds): the autostart plugin passes
    //     `--autostart` in argv.
    //   * MSIX StartupTask (Store builds): no argv flag is possible, so we ask
    //     Windows for the activation kind instead.
    // Manual launches keep the window visible — same UX as Slack/Discord.
    let launched_via_autostart = std::env::args().any(|a| a == "--autostart");
    #[cfg(target_os = "windows")]
    let launched_via_autostart = launched_via_autostart || launched_via_msix_startup();
    if let Some(win) = app.get_webview_window("main") {
        if launched_via_autostart {
            let _ = win.hide();
            tracing::info!("auto-launched — main window stays hidden in tray");
        } else {
            let _ = win.show();
            let _ = win.set_focus();
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
                critical: false, // soft hint — respects notifications setting
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

/// True if this process was launched by the OS at login via the MSIX
/// StartupTask (TaskId `VibePrompterStartup`).
///
/// MSIX installs don't get the `--autostart` argv flag — that flag only comes
/// from the registry-based `tauri-plugin-autostart` launcher, which we skip for
/// Store builds (see `apply_autostart`). The StartupTask launches the exe with
/// no arguments, so argv alone can't tell a login-launch from a manual click.
/// Instead we ask Windows for the activation kind: packaged desktop apps can
/// call `AppInstance::GetActivatedEventArgs` (Windows 10 1809+) and inspect
/// `Kind` — `StartupTask` means the OS started us at login.
///
/// Returns false on any error (not packaged → no package identity, API
/// unavailable, etc.), so non-MSIX builds fall back to the `--autostart` check.
#[cfg(target_os = "windows")]
fn launched_via_msix_startup() -> bool {
    use windows::ApplicationModel::AppInstance;
    use windows::ApplicationModel::Activation::ActivationKind;
    match AppInstance::GetActivatedEventArgs().and_then(|args| args.Kind()) {
        Ok(kind) => kind == ActivationKind::StartupTask,
        Err(_) => false,
    }
}

/// Enable or disable the MSIX StartupTask declared in the app manifest.
/// Returns Ok(()) if the WinRT StartupTask API is available (MSIX install).
/// Returns Err if not packaged or the task ID isn't registered — in that case
/// the caller falls back to the registry-based path.
/// TaskId must match Package.appxmanifest / AppxManifest.xml.
#[cfg(target_os = "windows")]
fn msix_startup_set(enabled: bool) -> anyhow::Result<()> {
    use windows::ApplicationModel::{StartupTask, StartupTaskState};
    use windows::core::HSTRING;
    let task = StartupTask::GetAsync(&HSTRING::from("VibePrompterStartup"))?.get()?;
    if enabled {
        let state = task.State()?;
        if matches!(
            state,
            StartupTaskState::Disabled | StartupTaskState::DisabledByUser
        ) {
            task.RequestEnableAsync()?.get()?;
        }
    } else {
        task.Disable()?;
    }
    Ok(())
}

/// Reconcile the OS autostart entry with the user's preference. Idempotent —
/// safe to call on every settings change and at every boot.
fn apply_autostart(app: &AppHandle, want_enabled: bool) {
    // Store (MSIX) installs: registry autostart doesn't work because the
    // executable lives in the protected WindowsApps folder and can't be
    // launched by a raw path. Try the WinRT StartupTask API first; if it
    // fails (not a packaged install, or task not registered in manifest),
    // fall back to the registry-based tauri-plugin-autostart path.
    #[cfg(target_os = "windows")]
    match msix_startup_set(want_enabled) {
        Ok(()) => {
            tracing::info!(
                "autostart {} (MSIX StartupTask)",
                if want_enabled { "enabled" } else { "disabled" }
            );
            return;
        }
        Err(e) => {
            tracing::debug!("MSIX StartupTask not available ({e}), using registry autostart");
        }
    }

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
