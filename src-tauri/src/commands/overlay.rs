//! Overlay window commands — bring the small auxiliary windows (mode-switch
//! HUD, future toast, future palette overlay) into view from the frontend or
//! from native code paths (tray menu, global shortcut).

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::utils::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeHudArgs {
    pub mode_id: String,
    pub mode_name: String,
    pub icon_name: Option<String>,
    /// Optional kicker (small uppercase line above the name). Defaults to
    /// "Mode switched" in the HUD when absent — set this to repurpose the
    /// HUD for one-off notifications (e.g. "Still running in tray").
    #[serde(default)]
    pub kicker: Option<String>,
}

/// Internal implementation — callable from any backend code path.
/// The `#[tauri::command]` wrapper below just forwards to this.
pub fn show_mode_hud_internal(app: AppHandle, args: ModeHudArgs) -> AppResult<()> {
    // Respect the user's notifications preference. The mode-switch HUD is a
    // soft notification — same category as a toast — so silencing should
    // silence this too. On read failure we default to showing, matching the
    // settings field's own `default = true`.
    let notifications_on = app
        .try_state::<crate::app::state::AppState>()
        .and_then(|state| {
            let svc = state.settings.clone();
            tauri::async_runtime::block_on(svc.get()).ok()
        })
        .map(|s| s.notifications)
        .unwrap_or(true);
    if !notifications_on {
        tracing::debug!("mode HUD suppressed: notifications disabled");
        return Ok(());
    }

    let window = app
        .get_webview_window("mode-hud")
        .ok_or_else(|| AppError::Config("mode-hud window not configured".into()))?;

    // Prefer the monitor the cursor is currently on (the user's active screen)
    // over the HUD window's last-seen monitor — global hotkeys fire from
    // anywhere, so "last-seen" is meaningless on a multi-monitor setup.
    let monitor = monitor_under_cursor(&app)
        .or_else(|| window.current_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let outer_size = window
            .outer_size()
            .map_err(|e| AppError::Config(format!("outer_size: {e}")))?;
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();

        let win_w_logical = outer_size.width as f64 / scale;
        let mon_w_logical = monitor_size.width as f64 / scale;
        let mon_h_logical = monitor_size.height as f64 / scale;
        let mon_x_logical = monitor_pos.x as f64 / scale;
        let mon_y_logical = monitor_pos.y as f64 / scale;

        let x = mon_x_logical + (mon_w_logical - win_w_logical) / 2.0;
        // ~12% from the top — same place Windows OSDs and Raycast confirmations sit.
        let y = mon_y_logical + mon_h_logical * 0.12;

        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }

    window
        .show()
        .map_err(|e| AppError::Config(format!("show window: {e}")))?;
    let _ = window.set_always_on_top(true);
    // The HUD is a passive notification: clicks should fall through to the
    // window behind it so the user doesn't lose focus on their work just
    // because the HUD happened to be where the cursor was.
    let _ = window.set_ignore_cursor_events(true);

    app.emit(
        "hud_show",
        serde_json::json!({
            "modeId": args.mode_id,
            "modeName": args.mode_name,
            "iconName": args.icon_name,
            "kicker": args.kicker,
        }),
    )
    .map_err(|e| AppError::Config(format!("emit hud_show: {e}")))?;

    tracing::debug!("mode HUD shown: {}", args.mode_name);
    Ok(())
}

#[tauri::command]
pub async fn show_mode_hud(app: AppHandle, args: ModeHudArgs) -> AppResult<()> {
    show_mode_hud_internal(app, args)
}

/// Cycle to the next catalog mode and pop the HUD. This is the same code path
/// the tray menu and global shortcut use — exposing it as a command lets the
/// in-app "Test mode HUD" button stay in lockstep instead of drifting against
/// a private hardcoded list.
#[tauri::command]
pub async fn cycle_mode_cmd(app: AppHandle) -> AppResult<()> {
    crate::tray::cycle_mode(&app)
}

/// Set the active mode by id. Same code path as the tray's "Set mode →"
/// submenu items so frontend and OS-side selections stay coherent.
#[tauri::command]
pub async fn set_active_mode(app: AppHandle, id: String) -> AppResult<()> {
    crate::tray::set_active_mode_by_id(&app, &id)
}

/// Hide the main window to the tray. The window can be re-shown via the
/// global `Ctrl+Shift+Space` shortcut, the tray icon left-click, or the tray
/// menu's "Show VibePrompter" item.
#[tauri::command]
pub async fn hide_main_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Quit the process — equivalent to the tray's "Quit" item. Lets the frontend
/// expose an explicit Exit button without duplicating the close-to-tray
/// override or relying on the OS-level window close button.
#[tauri::command]
pub async fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[derive(serde::Serialize)]
pub struct ActiveMode {
    pub id: String,
    pub name: String,
    #[serde(rename = "iconName")]
    pub icon_name: Option<String>,
}

/// Return the currently-active prompt mode tracked by the tray. The frontend
/// uses this to render an "active mode" indicator without duplicating the
/// cycle state.
#[tauri::command]
pub async fn get_active_mode(app: AppHandle) -> AppResult<ActiveMode> {
    let state = app
        .try_state::<crate::tray::TrayState>()
        .ok_or_else(|| AppError::Config("TrayState not initialized".into()))?;
    let m = state.current();
    Ok(ActiveMode { id: m.id, name: m.name, icon_name: m.icon_name })
}

/// Find the monitor whose bounds contain the current cursor position.
/// Returns `None` if the cursor position can't be read or no monitor matches —
/// the caller falls back to the window's own `current_monitor()` in that case.
fn monitor_under_cursor(app: &AppHandle) -> Option<tauri::Monitor> {
    let cursor = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    monitors.into_iter().find(|m| {
        let pos = m.position();
        let size = m.size();
        let cx = cursor.x as i32;
        let cy = cursor.y as i32;
        cx >= pos.x
            && cx < pos.x + size.width as i32
            && cy >= pos.y
            && cy < pos.y + size.height as i32
    })
}
