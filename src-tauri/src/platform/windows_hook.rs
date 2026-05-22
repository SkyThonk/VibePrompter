//! Windows low-level keyboard hook (WH_KEYBOARD_LL).
//!
//! Intercepts physical keystrokes before they reach ANY other application —
//! including apps that use RegisterHotKey or their own WH_KEYBOARD_LL hooks
//! registered earlier. When a registered combo is detected:
//!   1. The keystroke is swallowed (return 1, skip CallNextHookEx).
//!   2. The action string is sent to a channel; an async task dispatches it.
//!
//! Injected keystrokes from enigo (Ctrl+C / Ctrl+V synthesis) are skipped via
//! the LLKHF_INJECTED flag so we never swallow our own synthetic events.
//!
//! The hook is installed exactly once on the Tauri main thread (which owns the
//! Windows message pump). Subsequent calls to `install` only update the combo
//! list — they do not re-register the hook.

use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_F10,
    VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME,
    VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_RWIN,
    VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, WH_KEYBOARD_LL,
    WM_KEYDOWN, WM_SYSKEYDOWN,
};

struct HookEntry {
    vk: u16,
    ctrl: bool,
    alt: bool,
    shift: bool,
    win_key: bool,
    action: String,
}

// Shared between the installer and the hook proc. `try_lock` in the hook proc
// avoids deadlock on the rare case the main thread holds the lock.
static ENTRIES: Mutex<Vec<HookEntry>> = Mutex::new(Vec::new());

// Channel to dispatch actions from the hook proc (main thread) to the async
// runtime without blocking the Windows message pump.
static ACTION_TX: OnceLock<tokio::sync::mpsc::UnboundedSender<String>> = OnceLock::new();

// Guards against installing the hook more than once.
static HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

pub fn install(app: &tauri::AppHandle, shortcut_list: Vec<(String, String)>) {
    set_entries(shortcut_list);

    if HOOK_INSTALLED.set(()).is_err() {
        // Already installed — entries updated above, nothing else to do.
        return;
    }

    // Channel receiver runs on the async runtime; the hook proc sends and
    // immediately returns, keeping the message pump unblocked.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let _ = ACTION_TX.set(tx);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(action) = rx.recv().await {
            crate::shortcuts::dispatch_action(&app_clone, &action);
        }
    });

    // SetWindowsHookExW must be called from a thread that has a message pump.
    // Tauri's main thread runs the wry/tao event loop — perfect.
    let _ = app.run_on_main_thread(|| unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
        if hook.is_null() {
            tracing::warn!("priority_hook: SetWindowsHookExW failed — hotkey priority not active");
        } else {
            tracing::info!("priority_hook: WH_KEYBOARD_LL installed, VibePrompter hotkeys take priority");
        }
    });
}

fn set_entries(shortcut_list: Vec<(String, String)>) {
    let mut entries = ENTRIES.lock().unwrap();
    entries.clear();
    for (accel, action) in shortcut_list {
        match parse_accel(&accel) {
            Some(mut e) => {
                e.action = action;
                entries.push(e);
            }
            None => tracing::warn!("priority_hook: cannot parse accelerator '{accel}'"),
        }
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    if code >= 0 && (wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize) {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);

        // Skip keystrokes synthesized by enigo (our Ctrl+C / Ctrl+V injection).
        if kb.flags & LLKHF_INJECTED == 0 {
            let vk = kb.vkCode as u16;
            let ctrl = (GetAsyncKeyState(VK_CONTROL as i32) as u16) & 0x8000 != 0;
            let alt = (GetAsyncKeyState(VK_MENU as i32) as u16) & 0x8000 != 0;
            let shift = (GetAsyncKeyState(VK_SHIFT as i32) as u16) & 0x8000 != 0;
            let win_key = ((GetAsyncKeyState(VK_LWIN as i32) as u16)
                | (GetAsyncKeyState(VK_RWIN as i32) as u16))
                & 0x8000
                != 0;

            if let Ok(entries) = ENTRIES.try_lock() {
                for entry in entries.iter() {
                    if entry.vk == vk
                        && entry.ctrl == ctrl
                        && entry.alt == alt
                        && entry.shift == shift
                        && entry.win_key == win_key
                    {
                        if let Some(tx) = ACTION_TX.get() {
                            let _ = tx.send(entry.action.clone());
                        }
                        return 1; // Swallow — active app does not see this key
                    }
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

fn parse_accel(accel: &str) -> Option<HookEntry> {
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut win_key = false;
    let mut vk: Option<u16> = None;

    for part in accel.split('+') {
        match part.trim().to_lowercase().as_str() {
            "ctrl" | "control" | "cmdorctrl" | "commandorcontrol" => ctrl = true,
            "alt" => alt = true,
            "shift" => shift = true,
            "super" | "win" | "meta" | "cmd" | "command" => win_key = true,
            key => {
                if vk.is_some() {
                    return None; // Two non-modifier keys — invalid combo
                }
                vk = Some(key_to_vk(key)?);
            }
        }
    }

    Some(HookEntry { vk: vk?, ctrl, alt, shift, win_key, action: String::new() })
}

fn key_to_vk(key: &str) -> Option<u16> {
    Some(match key {
        "space" => VK_SPACE,
        "enter" | "return" => VK_RETURN,
        "tab" => VK_TAB,
        "escape" | "esc" => VK_ESCAPE,
        "backspace" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "insert" | "ins" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" | "prior" => VK_PRIOR,
        "pagedown" | "next" => VK_NEXT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "f1" => VK_F1,
        "f2" => VK_F2,
        "f3" => VK_F3,
        "f4" => VK_F4,
        "f5" => VK_F5,
        "f6" => VK_F6,
        "f7" => VK_F7,
        "f8" => VK_F8,
        "f9" => VK_F9,
        "f10" => VK_F10,
        "f11" => VK_F11,
        "f12" => VK_F12,
        k if k.len() == 1 => {
            let c = k.chars().next()?.to_ascii_uppercase();
            if c.is_ascii_alphanumeric() {
                c as u16
            } else {
                return None;
            }
        }
        _ => return None,
    })
}
