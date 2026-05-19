//! Refine overlay — the headline UX.
//!
//! Flow on global hotkey:
//!   1. Save current clipboard contents (we'll restore them at the end).
//!   2. Synthesize Ctrl+C to copy the user's selection from whatever app
//!      they were in.
//!   3. Read the clipboard. If it's still our saved value (nothing was
//!      selected, or the source app refused to copy), surface an error.
//!   4. Open the `refine-overlay` window near the OS cursor.
//!   5. Stream a completion through the active mode + default connection
//!      (or the mode's pinned connection), pushing tokens into the overlay.
//!   6. The overlay UI exposes Accept / Reject / Retry buttons. Accept
//!      writes the result to the clipboard and synthesizes Ctrl+V so the
//!      paste replaces the still-active selection in the source app, then
//!      restores the user's original clipboard.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::models::{ChatMessage, CompletionParams};
use crate::utils::{AppError, AppResult};

#[derive(Default)]
pub struct RefineSession {
    pub original_clipboard: Mutex<Option<String>>,
    pub selection: Mutex<Option<String>>,
    pub mode_id: Mutex<Option<String>>,
    /// Monotonic stream id. Bumped on every `begin` / `retry` / `reject`
    /// so the previous stream's still-arriving tokens can be detected as
    /// stale and dropped. Stops Retry from interleaving the prior run's
    /// trailing tokens into the new buffer.
    pub stream_seq: AtomicU64,
}

pub fn init(app: &AppHandle) {
    app.manage(RefineSession::default());
}

fn capture_selection(app: &AppHandle, prior: &Option<String>) -> AppResult<String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    std::thread::sleep(Duration::from_millis(80));

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| AppError::Config(format!("enigo init: {e}")))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| AppError::Config(format!("ctrl press: {e}")))?;
    enigo
        .key(Key::Unicode('c'), Direction::Click)
        .map_err(|e| AppError::Config(format!("c click: {e}")))?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|e| AppError::Config(format!("ctrl release: {e}")))?;

    let deadline = std::time::Instant::now() + Duration::from_millis(400);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(40));
        if let Ok(text) = app.clipboard().read_text() {
            if Some(&text) != prior.as_ref() && !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    Err(AppError::Validation(
        "no selection captured — highlight text in the source app first".into(),
    ))
}

fn position_near_cursor(app: &AppHandle) -> AppResult<()> {
    let win = app
        .get_webview_window("refine-overlay")
        .ok_or_else(|| AppError::Config("refine-overlay window not configured".into()))?;

    let cursor = match app.cursor_position() {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };

    let outer = win
        .outer_size()
        .map_err(|e| AppError::Config(format!("outer_size: {e}")))?;
    let monitor = win
        .current_monitor()
        .map_err(|e| AppError::Config(format!("current_monitor: {e}")))?
        .or_else(|| app.available_monitors().ok().and_then(|m| m.into_iter().next()));

    let (mon_pos, mon_size, scale) = match monitor {
        Some(m) => (*m.position(), *m.size(), m.scale_factor()),
        None => (
            tauri::PhysicalPosition::new(0, 0),
            tauri::PhysicalSize::new(1920, 1080),
            1.0,
        ),
    };

    let win_w = outer.width as f64 / scale;
    let win_h = outer.height as f64 / scale;
    let mon_x = mon_pos.x as f64 / scale;
    let mon_y = mon_pos.y as f64 / scale;
    let mon_w = mon_size.width as f64 / scale;
    let mon_h = mon_size.height as f64 / scale;
    let cur_x = cursor.x as f64 / scale;
    let cur_y = cursor.y as f64 / scale;

    let mut x = cur_x + 16.0;
    let mut y = cur_y + 16.0;
    if x + win_w > mon_x + mon_w {
        x = (cur_x - win_w - 16.0).max(mon_x + 8.0);
    }
    if y + win_h > mon_y + mon_h {
        y = (cur_y - win_h - 16.0).max(mon_y + 8.0);
    }

    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    Ok(())
}

pub async fn begin(app: AppHandle) -> AppResult<()> {
    let prior = app.clipboard().read_text().ok();

    let selection = match capture_selection(&app, &prior) {
        Ok(s) => s,
        Err(e) => {
            if let Some(p) = prior {
                let _ = app.clipboard().write_text(p);
            }
            return Err(e);
        }
    };

    let active = app
        .try_state::<crate::tray::TrayState>()
        .ok_or_else(|| AppError::Config("TrayState not initialized".into()))?
        .current();

    let session = app
        .try_state::<RefineSession>()
        .ok_or_else(|| AppError::Config("RefineSession not initialized".into()))?;
    *session.original_clipboard.lock().unwrap() = prior;
    *session.selection.lock().unwrap() = Some(selection.clone());
    *session.mode_id.lock().unwrap() = Some(active.id.clone());

    position_near_cursor(&app)?;
    let win = app
        .get_webview_window("refine-overlay")
        .ok_or_else(|| AppError::Config("refine-overlay window not configured".into()))?;
    win.show()
        .map_err(|e| AppError::Config(format!("show overlay: {e}")))?;
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();

    let seq = session.stream_seq.fetch_add(1, Ordering::SeqCst) + 1;

    let _ = app.emit(
        "refine:reset",
        serde_json::json!({
            "selection": selection,
            "modeId": active.id,
            "modeName": active.name,
            "iconName": active.icon_name,
        }),
    );

    let app_for_stream = app.clone();
    let mode_id = active.id.clone();
    let sel = selection.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_stream(app_for_stream.clone(), mode_id, sel, seq).await {
            if is_current_stream(&app_for_stream, seq) {
                let _ = app_for_stream.emit("refine:error", e.to_string());
            }
        }
    });

    Ok(())
}

fn is_current_stream(app: &AppHandle, seq: u64) -> bool {
    app.try_state::<RefineSession>()
        .map(|s| s.stream_seq.load(Ordering::SeqCst) == seq)
        .unwrap_or(false)
}

async fn run_stream(app: AppHandle, mode_id: String, selection: String, seq: u64) -> AppResult<()> {
    let state = app
        .try_state::<crate::app::state::AppState>()
        .ok_or_else(|| AppError::Config("AppState not initialized".into()))?;

    let modes = state.catalog.list_modes().await?;
    let mode = modes
        .iter()
        .find(|m| m.id == mode_id)
        .ok_or_else(|| AppError::NotFound { entity: "prompt_mode", id: mode_id.clone() })?
        .clone();

    let resolved = mode.provider_override.clone().filter(|s| !s.is_empty());
    let row = match resolved.as_deref() {
        Some(id) => state.connections.get_row(id).await?,
        None => state
            .connections
            .get_default_row()
            .await?
            .ok_or_else(|| AppError::Validation("no default connection configured".into()))?,
    };

    let messages = vec![ChatMessage { role: "user".into(), content: selection.clone() }];
    let params = CompletionParams {
        model: None,
        temperature: Some(mode.temperature),
        max_tokens: Some(mode.max_tokens as u32),
        system: Some(mode.system_prompt.clone()),
    };

    let cfg = state.connections.http_config().await;
    let _permit = state.connections.acquire_permit().await;
    let app_for_tokens = app.clone();
    let app_for_cancel = app.clone();
    let result = crate::providers::complete_stream(
        &row,
        messages,
        params,
        &cfg,
        move |delta| {
            if is_current_stream(&app_for_tokens, seq) {
                let _ = app_for_tokens.emit("refine:token", delta);
            }
        },
        // Refine uses its seq-based supersession for cancel; if the user
        // hits Retry, this stream becomes stale and the next chunk bails.
        move || !is_current_stream(&app_for_cancel, seq),
    )
    .await?;

    if !is_current_stream(&app, seq) {
        // We got back the final response from a stale stream — discard it
        // silently. History still records below; that's intentional, the
        // run did happen and the user might want to inspect it.
    }
    // Stamp connection recency on successful completion regardless of
    // whether this is the current stream — the request DID hit the wire.
    state.connections.mark_used(&row.id).await;

    let _ = state
        .history
        .record(crate::models::NewHistoryItem {
            mode_name: mode.name,
            icon_name: mode.icon_name,
            provider_label: format!("{} · {}", row.label, result.model),
            source_text: selection,
            output_text: result.text.clone(),
            latency_ms: result.latency_ms as i64,
            input_tokens: result.usage.input_tokens as i64,
            output_tokens: result.usage.output_tokens as i64,
        })
        .await;

    if is_current_stream(&app, seq) {
        let _ = app.emit("refine:done", &result);
    }
    Ok(())
}

pub async fn retry(app: AppHandle) -> AppResult<()> {
    let session = app
        .try_state::<RefineSession>()
        .ok_or_else(|| AppError::Config("RefineSession not initialized".into()))?;
    let selection = session
        .selection
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Validation("no active refine session".into()))?;
    let mode_id = session
        .mode_id
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Validation("no active refine session".into()))?;

    let seq = session.stream_seq.fetch_add(1, Ordering::SeqCst) + 1;

    let _ = app.emit("refine:reset_text", ());
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_stream(app2.clone(), mode_id, selection, seq).await {
            if is_current_stream(&app2, seq) {
                let _ = app2.emit("refine:error", e.to_string());
            }
        }
    });
    Ok(())
}

pub async fn accept(app: AppHandle, refined: String) -> AppResult<()> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let session = app
        .try_state::<RefineSession>()
        .ok_or_else(|| AppError::Config("RefineSession not initialized".into()))?;
    let original = session.original_clipboard.lock().unwrap().clone();

    // Hide overlay BEFORE the paste so focus returns to the source window.
    if let Some(win) = app.get_webview_window("refine-overlay") {
        let _ = win.hide();
    }

    app.clipboard()
        .write_text(refined.clone())
        .map_err(|e| AppError::Validation(format!("write clipboard: {e}")))?;

    std::thread::sleep(Duration::from_millis(140));

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| AppError::Config(format!("enigo init: {e}")))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| AppError::Config(format!("ctrl press: {e}")))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| AppError::Config(format!("v click: {e}")))?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|e| AppError::Config(format!("ctrl release: {e}")))?;

    let app_for_restore = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if let Some(prior) = original {
            let _ = app_for_restore.clipboard().write_text(prior);
        }
    });

    clear_session(&app);
    Ok(())
}

pub fn reject(app: AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("refine-overlay") {
        let _ = win.hide();
    }
    let session = app
        .try_state::<RefineSession>()
        .ok_or_else(|| AppError::Config("RefineSession not initialized".into()))?;
    // Bump the seq so any tokens still in flight from the canceled stream
    // get dropped instead of leaking into the next session.
    session.stream_seq.fetch_add(1, Ordering::SeqCst);
    if let Some(prior) = session.original_clipboard.lock().unwrap().take() {
        let _ = app.clipboard().write_text(prior);
    }
    clear_session(&app);
    Ok(())
}

fn clear_session(app: &AppHandle) {
    if let Some(session) = app.try_state::<RefineSession>() {
        *session.original_clipboard.lock().unwrap() = None;
        *session.selection.lock().unwrap() = None;
        *session.mode_id.lock().unwrap() = None;
    }
}
