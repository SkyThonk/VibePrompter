//! Platform-specific integrations. Currently provides a Windows low-level
//! keyboard hook that ensures VibePrompter's hotkeys take priority over any
//! active application, including those that register their own shortcuts via
//! RegisterHotKey or WH_KEYBOARD_LL hooks.

#[cfg(target_os = "windows")]
mod windows_hook;
#[cfg(target_os = "windows")]
mod uia;

/// Install the platform keyboard priority hook and register the given
/// (accelerator, action) pairs. Safe to call multiple times — the hook is
/// installed only once; subsequent calls update the registered combos.
#[cfg(target_os = "windows")]
pub fn install(app: &tauri::AppHandle, entries: Vec<(String, String)>) {
    windows_hook::install(app, entries);
}

#[cfg(not(target_os = "windows"))]
pub fn install(_app: &tauri::AppHandle, _entries: Vec<(String, String)>) {}

/// Try to read the focused element's active text selection via UI Automation
/// without touching the clipboard. Returns None when UIA is unavailable or the
/// focused element doesn't expose a text pattern — caller falls back to Ctrl+C.
pub fn get_selected_text_uia() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        uia::get_selected_text()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}
