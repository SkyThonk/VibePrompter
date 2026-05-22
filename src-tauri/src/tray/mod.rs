//! System tray icon + menu for VibePrompter.
//!
//! Owns the currently-active prompt mode and exposes it through the tray menu
//! and a `cycle_mode` action that drives the transparent mode-switch HUD. The
//! mode list is hydrated from the seeded `prompt_modes` catalog at startup so
//! the tray stays in sync with whatever the rest of the app shows.

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::commands::overlay::{show_mode_hud_internal, ModeHudArgs};
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct TrayMode {
    pub id: String,
    pub name: String,
    pub icon_name: Option<String>,
}

pub struct TrayState {
    pub modes: Mutex<Vec<TrayMode>>,
    cursor: Mutex<usize>,
}

/// Per-mode menu items inside the "Set mode" submenu, kept so the bullet
/// indicator (`●`) can be moved when the active mode changes.
struct TrayModeItems(Vec<MenuItem<Wry>>);

impl TrayState {
    fn new_with_cursor(modes: Vec<TrayMode>, start: usize) -> Self {
        debug_assert!(!modes.is_empty(), "TrayState requires at least one mode");
        let cursor = if modes.is_empty() { 0 } else { start % modes.len() };
        Self {
            modes: Mutex::new(modes),
            cursor: Mutex::new(cursor),
        }
    }

    pub fn current(&self) -> TrayMode {
        let modes = self.modes.lock().unwrap();
        let i = (*self.cursor.lock().unwrap()).min(modes.len().saturating_sub(1));
        modes[i].clone()
    }

    pub fn advance(&self) -> TrayMode {
        let modes = self.modes.lock().unwrap();
        let mut g = self.cursor.lock().unwrap();
        *g = (*g + 1) % modes.len();
        modes[*g].clone()
    }

    /// Jump the cursor to a specific mode by id; returns the new active mode
    /// or `None` if the id isn't in the catalog.
    pub fn set_by_id(&self, id: &str) -> Option<TrayMode> {
        let modes = self.modes.lock().unwrap();
        let pos = modes.iter().position(|m| m.id == id)?;
        *self.cursor.lock().unwrap() = pos;
        Some(modes[pos].clone())
    }

    /// Snapshot of the mode list (for iteration without holding the lock).
    pub fn snapshot(&self) -> Vec<TrayMode> {
        self.modes.lock().unwrap().clone()
    }

    /// Replace the mode list. Preserves the active mode id if still present;
    /// otherwise resets to the first mode. Returns the new active mode so
    /// the caller can re-emit `mode_changed` if the active mode shifted.
    pub fn replace_modes(&self, new_modes: Vec<TrayMode>) -> Option<TrayMode> {
        if new_modes.is_empty() {
            return None;
        }
        let prior_id = self.current().id;
        let new_pos = new_modes
            .iter()
            .position(|m| m.id == prior_id)
            .unwrap_or(0);
        *self.modes.lock().unwrap() = new_modes.clone();
        *self.cursor.lock().unwrap() = new_pos;
        Some(new_modes[new_pos].clone())
    }
}

/// Accelerator hints shown next to tray menu items. Read from the shortcuts
/// catalog at startup so the labels stay in sync with what the user has
/// configured. Both are optional — if a binding is missing or disabled, the
/// menu just omits the hint and the click path still works.
#[derive(Debug, Default, Clone)]
pub struct TrayAccelerators {
    pub palette: Option<String>,
    pub mode_switch: Option<String>,
}

/// Stash the current accelerators in managed state so `rebuild_modes` can
/// re-apply them when reconstructing the menu after a catalog change.
struct TrayAccelStash(TrayAccelerators);

/// Build the tray icon, attaching a menu hydrated from the catalog. The
/// `initial_mode_id` lets the caller restore the last-active mode from
/// persistent storage so the tray's "currently X" survives a restart.
pub fn init(
    app: &AppHandle,
    modes: Vec<TrayMode>,
    initial_mode_id: Option<&str>,
    accels: TrayAccelerators,
) -> AppResult<()> {
    if modes.is_empty() {
        return Err(AppError::Config("tray init: empty mode list".into()));
    }
    let start = initial_mode_id
        .and_then(|id| modes.iter().position(|m| m.id == id))
        .unwrap_or(0);
    let initial = modes[start].clone();
    app.manage(TrayState::new_with_cursor(modes, start));
    app.manage(TrayAccelStash(accels.clone()));

    let show_item = MenuItem::with_id(app, "tray.show", "Show VibePrompter", true, None::<&str>)
        .map_err(|e| AppError::Config(format!("tray menu show: {e}")))?;
    let palette_item = MenuItem::with_id(
        app,
        "tray.palette",
        "Open command palette",
        true,
        accels.palette.as_deref(),
    )
    .map_err(|e| AppError::Config(format!("tray menu palette: {e}")))?;
    let cycle_item = MenuItem::with_id(
        app,
        "tray.cycle",
        &format!("Switch mode — currently {}", initial.name),
        true,
        accels.mode_switch.as_deref(),
    )
    .map_err(|e| AppError::Config(format!("tray menu cycle: {e}")))?;

    // Build a "Set mode →" submenu listing every catalog mode so the user can
    // pick directly instead of cycling. Each item carries an id of the form
    // `tray.mode:<id>` which the menu-event handler parses back.
    let modes_snapshot = app.state::<TrayState>().snapshot();
    let mut mode_items: Vec<MenuItem<Wry>> = Vec::with_capacity(modes_snapshot.len());
    for m in &modes_snapshot {
        let label = if m.id == initial.id {
            format!("● {}", m.name)
        } else {
            format!("   {}", m.name)
        };
        let item = MenuItem::with_id(
            app,
            format!("tray.mode:{}", m.id),
            &label,
            true,
            None::<&str>,
        )
        .map_err(|e| AppError::Config(format!("tray mode item: {e}")))?;
        mode_items.push(item);
    }
    let mode_refs: Vec<&MenuItem<Wry>> = mode_items.iter().collect();
    let mode_dyn_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        mode_refs.iter().map(|m| *m as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let modes_submenu = Submenu::with_id_and_items(
        app,
        "tray.modes_submenu",
        "Set mode",
        true,
        &mode_dyn_refs,
    )
    .map_err(|e| AppError::Config(format!("tray modes submenu: {e}")))?;
    app.manage(TrayModeItems(mode_items));
    let sep = PredefinedMenuItem::separator(app)
        .map_err(|e| AppError::Config(format!("tray menu sep: {e}")))?;
    let settings_item =
        MenuItem::with_id(app, "tray.settings", "Settings…", true, None::<&str>)
            .map_err(|e| AppError::Config(format!("tray menu settings: {e}")))?;
    let sep2 = PredefinedMenuItem::separator(app)
        .map_err(|e| AppError::Config(format!("tray menu sep2: {e}")))?;
    let quit_item = MenuItem::with_id(app, "tray.quit", "Quit", true, None::<&str>)
        .map_err(|e| AppError::Config(format!("tray menu quit: {e}")))?;

    let menu: Menu<Wry> = Menu::with_items(
        app,
        &[
            &show_item,
            &palette_item,
            &cycle_item,
            &modes_submenu,
            &sep,
            &settings_item,
            &sep2,
            &quit_item,
        ],
    )
    .map_err(|e| AppError::Config(format!("tray menu build: {e}")))?;

    // Stash the cycle item so we can update its label on each switch.
    app.manage(TrayCycleItem(cycle_item.clone()));

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip(format!("VibePrompter — mode: {}", initial.name))
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            AppError::Config("default window icon missing — required for tray".into())
        })?)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_icon_event)
        .build(app)
        .map_err(|e| AppError::Config(format!("tray build: {e}")))?;

    tracing::info!("system tray initialized");
    Ok(())
}

/// Rebuild the tray menu after the mode catalog changed (new/edited/
/// deleted mode). Pulls fresh modes from the catalog, swaps the menu on
/// the existing tray icon, and re-manages the menu-item handles. Active
/// mode id is preserved when still present.
pub async fn rebuild_modes(app: &AppHandle) -> AppResult<()> {
    let state = app
        .try_state::<crate::app::state::AppState>()
        .ok_or_else(|| AppError::Config("AppState not initialized".into()))?;
    let modes = state.catalog.list_modes().await?;
    // Mirror the filter in `app/setup.rs`: hide built-in modes from the tray
    // submenu and cycle rotation. They're reached via dedicated shortcuts.
    let tray_modes: Vec<TrayMode> = modes
        .into_iter()
        .filter(|m| m.enabled && !m.is_system)
        .map(|m| TrayMode { id: m.id, name: m.name, icon_name: Some(m.icon_name) })
        .collect();
    if tray_modes.is_empty() {
        tracing::warn!("rebuild_modes: catalog empty, skipping");
        return Ok(());
    }

    let tray_state = app
        .try_state::<TrayState>()
        .ok_or_else(|| AppError::Config("TrayState not initialized".into()))?;
    let active = tray_state
        .replace_modes(tray_modes.clone())
        .ok_or_else(|| AppError::Config("replace_modes returned None".into()))?;

    let accels = app
        .try_state::<TrayAccelStash>()
        .map(|s| s.0.clone())
        .unwrap_or_default();

    // Build the new menu pieces. Same layout as `init` — keep them in sync.
    let show_item =
        MenuItem::with_id(app, "tray.show", "Show VibePrompter", true, None::<&str>)
            .map_err(|e| AppError::Config(format!("rebuild show: {e}")))?;
    let palette_item = MenuItem::with_id(
        app,
        "tray.palette",
        "Open command palette",
        true,
        accels.palette.as_deref(),
    )
    .map_err(|e| AppError::Config(format!("rebuild palette: {e}")))?;
    let cycle_item = MenuItem::with_id(
        app,
        "tray.cycle",
        &format!("Switch mode — currently {}", active.name),
        true,
        accels.mode_switch.as_deref(),
    )
    .map_err(|e| AppError::Config(format!("rebuild cycle: {e}")))?;

    let mut mode_items: Vec<MenuItem<Wry>> = Vec::with_capacity(tray_modes.len());
    for m in &tray_modes {
        let label = if m.id == active.id {
            format!("● {}", m.name)
        } else {
            format!("   {}", m.name)
        };
        let item =
            MenuItem::with_id(app, format!("tray.mode:{}", m.id), &label, true, None::<&str>)
                .map_err(|e| AppError::Config(format!("rebuild mode item: {e}")))?;
        mode_items.push(item);
    }
    let mode_dyn_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = mode_items
        .iter()
        .map(|m| m as &dyn tauri::menu::IsMenuItem<Wry>)
        .collect();
    let modes_submenu = Submenu::with_id_and_items(
        app,
        "tray.modes_submenu",
        "Set mode",
        true,
        &mode_dyn_refs,
    )
    .map_err(|e| AppError::Config(format!("rebuild modes submenu: {e}")))?;

    let sep = PredefinedMenuItem::separator(app)
        .map_err(|e| AppError::Config(format!("rebuild sep: {e}")))?;
    let settings_item =
        MenuItem::with_id(app, "tray.settings", "Settings…", true, None::<&str>)
            .map_err(|e| AppError::Config(format!("rebuild settings: {e}")))?;
    let sep2 = PredefinedMenuItem::separator(app)
        .map_err(|e| AppError::Config(format!("rebuild sep2: {e}")))?;
    let quit_item = MenuItem::with_id(app, "tray.quit", "Quit", true, None::<&str>)
        .map_err(|e| AppError::Config(format!("rebuild quit: {e}")))?;

    let menu: Menu<Wry> = Menu::with_items(
        app,
        &[
            &show_item,
            &palette_item,
            &cycle_item,
            &modes_submenu,
            &sep,
            &settings_item,
            &sep2,
            &quit_item,
        ],
    )
    .map_err(|e| AppError::Config(format!("rebuild menu: {e}")))?;

    // Re-manage the dynamic handles so cycle/click still finds them.
    app.manage(TrayCycleItem(cycle_item));
    app.manage(TrayModeItems(mode_items));

    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_tooltip(Some(format!("VibePrompter — mode: {}", active.name)));
    }

    // The active mode might have shifted (e.g. user deleted the active mode).
    let _ = app.emit(
        "mode_changed",
        serde_json::json!({ "id": active.id, "name": active.name, "iconName": active.icon_name }),
    );
    Ok(())
}

/// Wrapper so we can stash the dynamic cycle menu item in Tauri-managed state
/// without exposing the concrete `MenuItem<Wry>` type at the call sites.
struct TrayCycleItem(MenuItem<Wry>);

pub fn cycle_mode(app: &AppHandle) -> AppResult<()> {
    let state = app
        .try_state::<TrayState>()
        .ok_or_else(|| AppError::Config("TrayState not initialized".into()))?;
    let next = state.advance();
    apply_active_mode(app, next)
}

/// Jump directly to a mode by id (used by the "Set mode" tray submenu and the
/// `set_active_mode` command). No-op when the id isn't in the catalog.
pub fn set_active_mode_by_id(app: &AppHandle, id: &str) -> AppResult<()> {
    let state = app
        .try_state::<TrayState>()
        .ok_or_else(|| AppError::Config("TrayState not initialized".into()))?;
    let Some(next) = state.set_by_id(id) else {
        return Err(AppError::Validation(format!("unknown mode id: {id}")));
    };
    apply_active_mode(app, next)
}

/// Side-effects shared by `cycle_mode` and `set_active_mode_by_id`: update the
/// tray labels, persist the new id, fire `mode_changed`, and show the HUD.
fn apply_active_mode(app: &AppHandle, next: TrayMode) -> AppResult<()> {
    if let Some(item) = app.try_state::<TrayCycleItem>() {
        let _ = item.0.set_text(format!("Switch mode — currently {}", next.name));
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(format!("VibePrompter — mode: {}", next.name)));
    }
    // Refresh the bullet (●) inside the "Set mode" submenu so the indicator
    // tracks the new active mode.
    if let (Some(items), Some(state)) = (
        app.try_state::<TrayModeItems>(),
        app.try_state::<TrayState>(),
    ) {
        for (i, m) in state.snapshot().iter().enumerate() {
            if let Some(item) = items.0.get(i) {
                let label = if m.id == next.id {
                    format!("● {}", m.name)
                } else {
                    format!("   {}", m.name)
                };
                let _ = item.set_text(label);
            }
        }
    }

    // Persist last-active mode so the cursor survives a restart. Fire-and-
    // forget — a single failed write should not block a UI action.
    if let Some(app_state) = app.try_state::<crate::app::state::AppState>() {
        let svc = app_state.settings.clone();
        let id = next.id.clone();
        tauri::async_runtime::spawn(async move {
            let json = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".into());
            if let Err(e) = svc.set_kv("active_mode_id", &json).await {
                tracing::warn!("persist active_mode_id failed: {e}");
            }
        });
    }

    let _ = app.emit(
        "mode_changed",
        serde_json::json!({
            "id": next.id,
            "name": next.name,
            "iconName": next.icon_name,
        }),
    );

    // The HUD itself is enough signal for a mode switch; a duplicate native
    // OS toast in the Action Center was felt as noise (see UX feedback).
    show_mode_hud_internal(
        app.clone(),
        ModeHudArgs {
            mode_id: next.id,
            mode_name: next.name,
            icon_name: next.icon_name,
            kicker: None,
            critical: false, // mode switch is soft — respects user setting
        },
    )
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "tray.show" => show_main_window(app),
        "tray.palette" => toggle_main_window(app),
        "tray.cycle" => {
            if let Err(e) = cycle_mode(app) {
                tracing::warn!("tray cycle_mode failed: {e}");
            }
        }
        "tray.settings" => {
            show_main_window(app);
            // The frontend's AppRouter listens for this event and pushes
            // /settings — keeps routing decisions in the React layer where
            // they belong, rather than coupling to URL fragments here.
            let _ = app.emit("navigate", "/settings");
        }
        "tray.quit" => app.exit(0),
        other if other.starts_with("tray.mode:") => {
            let id = &other["tray.mode:".len()..];
            if let Err(e) = set_active_mode_by_id(app, id) {
                tracing::warn!("set_active_mode_by_id({id}) failed: {e}");
            }
        }
        _ => {}
    }
}

fn handle_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        show_main_window(tray.app_handle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_modes() -> Vec<TrayMode> {
        vec![
            TrayMode { id: "developer".into(), name: "Developer".into(), icon_name: None },
            TrayMode { id: "email".into(), name: "Email".into(), icon_name: None },
            TrayMode { id: "friendly".into(), name: "Friendly".into(), icon_name: None },
        ]
    }

    #[test]
    fn advance_wraps_at_end() {
        let s = TrayState::new_with_cursor(mk_modes(), 0);
        assert_eq!(s.advance().id, "email");
        assert_eq!(s.advance().id, "friendly");
        // Third advance wraps to the first.
        assert_eq!(s.advance().id, "developer");
    }

    #[test]
    fn set_by_id_jumps_cursor() {
        let s = TrayState::new_with_cursor(mk_modes(), 0);
        assert_eq!(s.set_by_id("friendly").unwrap().id, "friendly");
        assert_eq!(s.current().id, "friendly");
        // Next advance picks the mode after the jumped-to one.
        assert_eq!(s.advance().id, "developer");
    }

    #[test]
    fn set_by_id_returns_none_for_unknown() {
        let s = TrayState::new_with_cursor(mk_modes(), 1);
        assert!(s.set_by_id("nope").is_none());
        // Cursor unchanged on miss.
        assert_eq!(s.current().id, "email");
    }

    #[test]
    fn new_with_cursor_clamps_out_of_range() {
        let s = TrayState::new_with_cursor(mk_modes(), 999);
        assert_eq!(s.current().id, "developer"); // 999 % 3 == 0
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Navigate to the startup route before showing so the frontend
        // re-evaluates routing (avoids stale /setup route after hide-to-tray).
        let was_hidden = !window.is_visible().unwrap_or(true);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if was_hidden {
            let _ = tauri::Emitter::emit(app, "navigate", "/");
        }
    }
}

pub fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
