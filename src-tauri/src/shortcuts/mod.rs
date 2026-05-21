//! OS-level global hotkey registration. Reads shortcut bindings from the
//! `shortcuts` table (via `ShortcutService`) so the accelerators the user sees
//! in Settings are the same ones that actually trigger. Actions that don't
//! yet have a backend (rewrite/grammar/summarize — provider sub-project) are
//! registered but no-op with a debug log, so the keys round-trip cleanly.

use std::collections::HashMap;
use std::str::FromStr;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::utils::{AppError, AppResult};

pub async fn init(app: &AppHandle) -> AppResult<()> {
    let state = app
        .try_state::<crate::app::state::AppState>()
        .ok_or_else(|| AppError::Config("AppState not initialized".into()))?;
    let items = state.shortcuts.list().await?;

    let gs = app.global_shortcut();
    let _ = gs.unregister_all(); // idempotent — safe on first call

    // Pre-pass: warn about duplicate accelerators across enabled shortcuts.
    // The global-shortcut plugin would silently bind the first and reject the
    // rest — surfacing the conflict in the log helps the user notice their
    // Settings change collided with another binding.
    let mut by_accel: HashMap<String, Vec<&str>> = HashMap::new();
    for item in items.iter().filter(|i| i.enabled) {
        by_accel
            .entry(item.accelerator.clone())
            .or_default()
            .push(&item.id);
    }
    for (accel, ids) in by_accel.iter().filter(|(_, v)| v.len() > 1) {
        tracing::warn!(
            "shortcut accelerator '{accel}' bound to multiple actions ({}); first wins",
            ids.join(", ")
        );
    }

    for item in items {
        if !item.enabled {
            continue;
        }
        let shortcut = match Shortcut::from_str(&item.accelerator) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    "skipping shortcut '{}': cannot parse accelerator '{}': {e}",
                    item.id,
                    item.accelerator
                );
                continue;
            }
        };
        let action = item.action.clone();
        let id = item.id.clone();
        let accel = item.accelerator.clone();

        if let Err(e) = gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            dispatch(app, &action);
        }) {
            tracing::warn!("failed to register {id} ({accel}): {e}");
        } else {
            tracing::info!("global shortcut registered: {} → {}", accel, item.action);
        }
    }

    Ok(())
}

/// Map a shortcut's `action` string to the corresponding backend behavior.
/// Unknown actions are logged at debug level and do nothing — they exist as
/// seeded rows for sub-project 2 to implement.
fn dispatch(app: &AppHandle, action: &str) {
    match action {
        "mode_switch" => {
            if let Err(e) = crate::tray::cycle_mode(app) {
                tracing::warn!("mode_switch dispatch failed: {e}");
            }
        }
        "open_palette" => crate::tray::toggle_main_window(app),
        // Rewrite / Grammar / Summarize all drive the same recipe: grab the
        // user's current text *selection* (not just clipboard) via a
        // synthesized Ctrl+C, open the refine overlay near the cursor,
        // stream the active mode's completion, and let the user accept the
        // replacement — paste-back is gated behind the Accept button so
        // we never silently overwrite their selection.
        "rewrite_selection" | "fix_grammar" | "summarize" => {
            let kind = match action {
                "fix_grammar" => crate::overlay::RefineKind::Grammar,
                "summarize" => crate::overlay::RefineKind::Summarize,
                _ => crate::overlay::RefineKind::Rewrite,
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::overlay::begin(app.clone(), kind).await {
                    let msg = e.to_string();
                    tracing::warn!("refine begin failed: {msg}");
                    // Specific recovery path for the most common failure
                    // mode: no connection / no API key. The user can't
                    // act on a tiny HUD — pop the main window on the
                    // providers panel so the fix is right there.
                    let needs_setup = msg.contains("no default connection")
                        || msg.contains("no API key")
                        || msg.contains("has no key");
                    if needs_setup {
                        crate::tray::show_main_window(&app);
                        let _ = tauri::Emitter::emit(&app, "navigate", "/settings/providers");
                        show_error_hud(&app, &msg);
                    } else if msg.contains("no selection captured") || msg.contains("overlay dismissed") {
                        // Friendly, action-oriented HUD instead of a scary
                        // error preview. Most common cause: user pressed
                        // the hotkey before highlighting anything, or pressed
                        // it again while the overlay was still open.
                        show_no_selection_hud(&app);
                    } else {
                        show_error_hud(&app, &msg);
                    }
                }
            });
        }
        other => {
            tracing::debug!("shortcut action '{other}' has no backend yet");
        }
    }
}

fn show_error_hud(app: &AppHandle, msg: &str) {
    // Surface a single-line summary; the full error is in the logs.
    // Marked `critical` so it shows even when the user has notifications
    // disabled — a hotkey that silently fails reads as a broken app.
    let preview = msg.chars().take(80).collect::<String>();
    let _ = crate::commands::overlay::show_mode_hud_internal(
        app.clone(),
        crate::commands::overlay::ModeHudArgs {
            mode_id: "error".into(),
            mode_name: preview,
            icon_name: Some("info".into()),
            kicker: Some("Prompt failed".into()),
            critical: true,
        },
    );
}

/// Friendly HUD for the "user pressed the hotkey but didn't select anything"
/// case. Common enough on first-run that a raw error preview reads as a bug;
/// a clear instruction tells the user what to do next. Marked `critical`
/// so it bypasses the notifications-off mute — the user pressed a hotkey
/// expecting an action; them not getting any feedback at all would be worse
/// than them getting feedback they didn't ask for.
fn show_no_selection_hud(app: &AppHandle) {
    let _ = crate::commands::overlay::show_mode_hud_internal(
        app.clone(),
        crate::commands::overlay::ModeHudArgs {
            mode_id: "no-selection".into(),
            mode_name: "No text selected".into(),
            icon_name: Some("text".into()),
            kicker: Some("Nothing highlighted".into()),
            critical: true,
        },
    );
}
