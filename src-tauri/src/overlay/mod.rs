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

/// Which user-facing action launched the overlay. Determines the prompt, the
/// header label, and the available actions in the overlay UI:
///
///   - `Rewrite`   — uses the active prompt mode end-to-end; full action set
///                   (Cancel / Retry / Replace).
///   - `Grammar`   — uses a fixed grammar-fix prompt regardless of active
///                   mode; same action set as Rewrite (you usually want to
///                   paste the corrected text back).
///   - `Summarize` — uses a fixed summarization prompt; output is rendered as
///                   bullets and the only commit action is Copy (we do not
///                   paste a summary back over the source text).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefineKind {
    Rewrite,
    Grammar,
    Summarize,
}

impl RefineKind {
    fn label(self) -> &'static str {
        match self {
            RefineKind::Rewrite => "Refine",
            RefineKind::Grammar => "Fix grammar",
            RefineKind::Summarize => "Summarize",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            RefineKind::Rewrite => "wand",
            RefineKind::Grammar => "text",
            RefineKind::Summarize => "summarize",
        }
    }

    /// Built-in prompts for Grammar/Summarize so the action is consistent
    /// regardless of which prompt mode the user happens to have active.
    /// `Rewrite` returns None so the caller falls back to the active mode's
    /// own system prompt + sampling.
    fn builtin_prompt(self) -> Option<&'static str> {
        match self {
            RefineKind::Rewrite => None,
            RefineKind::Grammar => Some(
                "Fix grammar, punctuation, and spelling in the user's text. \
                 Preserve meaning, tone, and language exactly. Reply with \
                 ONLY the corrected text — no preamble, no explanation, no \
                 quotes.",
            ),
            RefineKind::Summarize => Some(
                "Summarize the user's text as a tight bulleted list of the \
                 most important points. Use one short bullet per idea, each \
                 line starting with `- `. No preamble, no closing remarks.",
            ),
        }
    }
}

#[derive(Default)]
pub struct RefineSession {
    pub original_clipboard: Mutex<Option<String>>,
    pub selection: Mutex<Option<String>>,
    pub mode_id: Mutex<Option<String>>,
    /// Kind of refine session in flight. `retry` consults this so the
    /// rerun uses the same prompt/label the user originally launched with.
    pub kind: Mutex<Option<RefineKind>>,
    /// Last completed result text. Populated when `run_stream` finishes
    /// successfully, consumed by `followup` so the user can ask for a
    /// tweak ("make it shorter", "more formal") that the model receives
    /// alongside the original selection + the previous output.
    pub last_result: Mutex<Option<String>>,
    /// Optional per-session connection override. Set by the in-overlay
    /// model picker; takes priority over the mode's `provider_override`
    /// and the workspace default for the rest of this session. Cleared
    /// when the overlay hides.
    pub connection_override: Mutex<Option<String>>,
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

    // Clear the clipboard before synthesizing Ctrl+C. We used to compare the
    // post-copy clipboard against `prior` to detect "did the copy actually
    // succeed?", but that false-negatived whenever the user's clipboard
    // already contained the same string they were selecting (e.g. they just
    // pasted it). Clearing first means *any* non-empty text afterward is
    // proof of capture. `prior` is still passed in so the higher-level flow
    // can restore it after Accept/Reject.
    let _ = app.clipboard().write_text(String::new());

    // Short settle so enigo's input arrives after the OS finishes processing
    // the hotkey press. The bigger problem — modifiers still physically held
    // — is handled by the modifier-release calls inside `synth_copy` plus the
    // 250ms back-off + retry path below, so this initial pause stays small to
    // keep the common-case latency snappy.
    std::thread::sleep(Duration::from_millis(40));

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| AppError::Config(format!("enigo init: {e}")))?;

    // One attempt = release any modifier the OS still considers down, then
    // synthesize Ctrl+C. Idempotent — releasing an already-released key is a
    // no-op. We try twice with a longer settle between attempts so a long
    // physical key hold doesn't prevent capture.
    let synth_copy = |e: &mut Enigo| -> AppResult<()> {
        let _ = e.key(Key::Alt, Direction::Release);
        let _ = e.key(Key::Shift, Direction::Release);
        let _ = e.key(Key::Meta, Direction::Release);
        let _ = e.key(Key::Control, Direction::Release);
        std::thread::sleep(Duration::from_millis(40));
        e.key(Key::Control, Direction::Press)
            .map_err(|err| AppError::Config(format!("ctrl press: {err}")))?;
        e.key(Key::Unicode('c'), Direction::Click)
            .map_err(|err| AppError::Config(format!("c click: {err}")))?;
        e.key(Key::Control, Direction::Release)
            .map_err(|err| AppError::Config(format!("ctrl release: {err}")))?;
        Ok(())
    };

    synth_copy(&mut enigo)?;

    tracing::debug!(
        "capture_selection: prior_clipboard_len={}, polling for non-empty text…",
        prior.as_ref().map(|s| s.len()).unwrap_or(0)
    );

    // Clipboard was cleared above, so any non-empty text post-Ctrl+C is the
    // captured selection. Comparing against `prior` would false-negative when
    // the user's prior clipboard text equals the selection.
    let poll_for = |window_ms: u64| -> Option<String> {
        let deadline = std::time::Instant::now() + Duration::from_millis(window_ms);
        while std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(40));
            if let Ok(text) = app.clipboard().read_text() {
                if !text.trim().is_empty() {
                    return Some(text);
                }
            }
        }
        None
    };

    // First attempt — wait ~500ms for the clipboard to change.
    if let Some(text) = poll_for(500) {
        return Ok(text);
    }

    // Second attempt — modifiers may still have been held during the first
    // synthesis. Wait longer, then re-synthesize and poll again.
    tracing::debug!("capture_selection: first attempt produced no change, retrying");
    std::thread::sleep(Duration::from_millis(250));
    synth_copy(&mut enigo)?;
    if let Some(text) = poll_for(600) {
        return Ok(text);
    }

    let last_seen = app
        .clipboard()
        .read_text()
        .map(|s| s.len() as i64)
        .unwrap_or(-1);
    tracing::warn!(
        "capture_selection: both attempts produced no clipboard change \
         (prior_len={}, last_seen_len={})",
        prior.as_ref().map(|s| s.len() as i64).unwrap_or(-1),
        last_seen
    );
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

pub async fn begin(app: AppHandle, kind: RefineKind) -> AppResult<()> {
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
    *session.kind.lock().unwrap() = Some(kind);

    position_near_cursor(&app)?;
    let win = app
        .get_webview_window("refine-overlay")
        .ok_or_else(|| AppError::Config("refine-overlay window not configured".into()))?;
    win.show()
        .map_err(|e| AppError::Config(format!("show overlay: {e}")))?;
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();

    let seq = session.stream_seq.fetch_add(1, Ordering::SeqCst) + 1;

    // For Grammar/Summarize the user-facing label is the action name, not the
    // active mode. We still send modeId/modeName so the overlay can show the
    // provider/model strip when it wants to. `kind` drives header text +
    // button set on the React side.
    let header_name = match kind {
        RefineKind::Rewrite => active.name.clone(),
        other => other.label().to_string(),
    };
    let header_icon = match kind {
        RefineKind::Rewrite => active.icon_name.clone(),
        other => Some(other.icon().to_string()),
    };

    let _ = app.emit(
        "refine:reset",
        serde_json::json!({
            "selection": selection,
            "kind": kind,
            "modeId": active.id,
            "modeName": header_name,
            "iconName": header_icon,
        }),
    );

    let app_for_stream = app.clone();
    let mode_id = active.id.clone();
    let sel = selection.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_stream(app_for_stream.clone(), kind, mode_id, sel, seq).await {
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

async fn run_stream(
    app: AppHandle,
    kind: RefineKind,
    mode_id: String,
    selection: String,
    seq: u64,
) -> AppResult<()> {
    let state = app
        .try_state::<crate::app::state::AppState>()
        .ok_or_else(|| AppError::Config("AppState not initialized".into()))?;

    let modes = state.catalog.list_modes().await?;
    let mode = modes
        .iter()
        .find(|m| m.id == mode_id)
        .ok_or_else(|| AppError::NotFound { entity: "prompt_mode", id: mode_id.clone() })?
        .clone();

    // Grammar/Summarize override the mode's prompt with a built-in but keep
    // its sampling + pinned provider — so the user's preferred model still
    // serves the built-in actions. Rewrite uses the mode's prompt unchanged.
    let system_prompt = kind
        .builtin_prompt()
        .map(|s| s.to_string())
        .unwrap_or_else(|| mode.system_prompt.clone());
    // Substitute `{{var}}` placeholders with values from the mode's
    // saved defaults. Built-in prompts don't carry placeholders, so this
    // is a no-op for Grammar/Summarize unless the user adds variables
    // to a custom mode that the Rewrite hotkey is bound to.
    let system_prompt = crate::services::prompt_template::render(&system_prompt, &mode.variables);

    // Connection priority: session override (user picked one mid-overlay)
    // > mode's pinned provider > workspace default. Each step falls through
    // to the next if empty.
    let session_override = app
        .try_state::<RefineSession>()
        .and_then(|s| s.connection_override.lock().unwrap().clone());
    let resolved = session_override
        .or_else(|| mode.provider_override.clone().filter(|s| !s.is_empty()));
    let row = match resolved.as_deref() {
        Some(id) => state.connections.get_row(id).await?,
        None => state
            .connections
            .get_default_row()
            .await?
            .ok_or_else(|| AppError::Validation("no default connection configured".into()))?,
    };

    let messages = vec![ChatMessage { role: "user".into(), content: selection.clone() }];
    // Adaptive max_tokens: rewrite/grammar/tone modes produce output roughly
    // proportional to input length, so if the user selected 10 KB of text the
    // mode's static 1024 cap would truncate the response halfway through.
    // We estimate input tokens (≈chars/4) and scale max_tokens up so the
    // output has room. Summarize keeps its tight cap because output << input
    // by design. Hard ceiling at 16k to stay within every vendor's window
    // we ship a preset for; users with bigger contexts can raise the mode's
    // own max_tokens (which sets the floor).
    let estimated_input_tokens = (selection.chars().count() / 4) as i64;
    let effective_max_tokens: i64 = match kind {
        RefineKind::Summarize => mode.max_tokens,
        _ => {
            // 1.4× input headroom: same length back + room for the model to
            // breathe slightly. The mode's configured value is the floor —
            // users tuning for very short outputs still get what they asked.
            let scaled = (estimated_input_tokens as f64 * 1.4).ceil() as i64;
            mode.max_tokens.max(scaled).min(16_000)
        }
    };
    if estimated_input_tokens > 8000 {
        // Selections >~32 KB of text often hit context-window or rate-limit
        // problems silently. Drop a debug log + a one-shot HUD warning so
        // the user knows their request is unusually large.
        tracing::warn!(
            "refine: large selection (~{} tokens) — using max_tokens={}",
            estimated_input_tokens,
            effective_max_tokens
        );
        let _ = crate::commands::overlay::show_mode_hud_internal(
            app.clone(),
            crate::commands::overlay::ModeHudArgs {
                mode_id: "large-selection".into(),
                mode_name: format!(
                    "~{}K tokens selected — may hit context limits",
                    estimated_input_tokens / 1000
                ),
                icon_name: Some("info".into()),
                kicker: Some("Large selection".into()),
                // Critical — large selection may quietly truncate or rate-
                // limit. Better the user knows even with notifications off.
                critical: true,
            },
        );
    }
    let params = CompletionParams {
        model: None,
        temperature: Some(mode.temperature),
        max_tokens: Some(effective_max_tokens as u32),
        system: Some(system_prompt),
    };

    let cfg = state.connections.http_config().await;
    let _permit = state.connections.acquire_permit().await;
    // Honor the user's Stream-AI-response preference. When streaming is off,
    // call the blocking endpoint and emit the whole text as one delta so the
    // overlay UI fills in once (rather than always animating token-by-token).
    let stream_pref = state
        .settings
        .get()
        .await
        .map(|s| s.stream_response)
        .unwrap_or(true);
    let result = if stream_pref {
        let app_for_tokens = app.clone();
        let app_for_cancel = app.clone();
        crate::providers::complete_stream(
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
        .await?
    } else {
        let r = crate::providers::complete(&row, messages, params, &cfg).await?;
        if is_current_stream(&app, seq) {
            // One delta emission so the overlay's token-accumulator renders
            // the full text without changing the frontend at all.
            let _ = app.emit("refine:token", r.text.as_str());
        }
        r
    };

    if !is_current_stream(&app, seq) {
        // We got back the final response from a stale stream — discard it
        // silently. History still records below; that's intentional, the
        // run did happen and the user might want to inspect it.
    }
    // Stamp connection recency on successful completion regardless of
    // whether this is the current stream — the request DID hit the wire.
    state.connections.mark_used(&row.id).await;

    let cost_micros = crate::services::pricing::cost_micros(
        &result.model,
        result.usage.input_tokens as i64,
        result.usage.output_tokens as i64,
        row.price_input_per_m,
        row.price_output_per_m,
    );
    // For Grammar / Summarize hotkeys, the *prompt* is the built-in one
    // regardless of which user-rewrite mode happens to be active. The
    // history row should reflect the action the user actually invoked,
    // not the currently-selected rewrite mode (which only governs the
    // Ctrl+Alt+Space hotkey). Use the kind's display label + icon for
    // those two cases; only plain Rewrite inherits the active mode.
    let (history_mode_name, history_icon) = match kind {
        RefineKind::Rewrite => (mode.name.clone(), mode.icon_name.clone()),
        other => (other.label().to_string(), other.icon().to_string()),
    };
    let _ = state
        .history
        .record(crate::models::NewHistoryItem {
            mode_name: history_mode_name,
            icon_name: history_icon,
            provider_label: format!("{} · {}", row.label, result.model),
            source_text: selection,
            output_text: result.text.clone(),
            latency_ms: result.latency_ms as i64,
            input_tokens: result.usage.input_tokens as i64,
            output_tokens: result.usage.output_tokens as i64,
            cost_micros,
        })
        .await;

    if is_current_stream(&app, seq) {
        // Cache the latest result on the session so `followup` can build a
        // multi-turn conversation off of it. Stale stream results don't
        // overwrite because we only do it on the current-stream branch.
        if let Some(s) = app.try_state::<RefineSession>() {
            *s.last_result.lock().unwrap() = Some(result.text.clone());
        }
        let _ = app.emit("refine:done", &result);
    }
    Ok(())
}

/// Multi-turn refinement. The user types a free-form instruction
/// ("make it shorter", "more formal", "translate to Spanish") and we
/// re-fire the conversation as `[user: original, assistant: last_result,
/// user: instruction]`. Result replaces the current overlay text. Chains
/// across multiple followups because each new result is written back to
/// `session.last_result`.
pub async fn followup(app: AppHandle, instruction: String) -> AppResult<()> {
    let instruction = instruction.trim().to_string();
    if instruction.is_empty() {
        return Err(AppError::Validation("followup instruction is empty".into()));
    }
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
    let kind = session
        .kind
        .lock()
        .unwrap()
        .unwrap_or(RefineKind::Rewrite);
    let prior = session
        .last_result
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Validation("no previous result to refine".into()))?;

    let seq = session.stream_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("refine:reset_text", ());

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            run_followup_stream(app_for_task.clone(), kind, mode_id, selection, prior, instruction, seq)
                .await
        {
            if is_current_stream(&app_for_task, seq) {
                let _ = app_for_task.emit("refine:error", e.to_string());
            }
        }
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_followup_stream(
    app: AppHandle,
    kind: RefineKind,
    mode_id: String,
    selection: String,
    prior_result: String,
    instruction: String,
    seq: u64,
) -> AppResult<()> {
    let state = app
        .try_state::<crate::app::state::AppState>()
        .ok_or_else(|| AppError::Config("AppState not initialized".into()))?;
    let modes = state.catalog.list_modes().await?;
    let mode = modes
        .iter()
        .find(|m| m.id == mode_id)
        .ok_or_else(|| AppError::NotFound { entity: "prompt_mode", id: mode_id.clone() })?
        .clone();
    let system_prompt = kind
        .builtin_prompt()
        .map(|s| s.to_string())
        .unwrap_or_else(|| mode.system_prompt.clone());
    // Substitute `{{var}}` placeholders with values from the mode's
    // saved defaults. Built-in prompts don't carry placeholders, so this
    // is a no-op for Grammar/Summarize unless the user adds variables
    // to a custom mode that the Rewrite hotkey is bound to.
    let system_prompt = crate::services::prompt_template::render(&system_prompt, &mode.variables);

    // Connection priority: session override (user picked one mid-overlay)
    // > mode's pinned provider > workspace default. Each step falls through
    // to the next if empty.
    let session_override = app
        .try_state::<RefineSession>()
        .and_then(|s| s.connection_override.lock().unwrap().clone());
    let resolved = session_override
        .or_else(|| mode.provider_override.clone().filter(|s| !s.is_empty()));
    let row = match resolved.as_deref() {
        Some(id) => state.connections.get_row(id).await?,
        None => state
            .connections
            .get_default_row()
            .await?
            .ok_or_else(|| AppError::Validation("no default connection configured".into()))?,
    };

    let messages = vec![
        ChatMessage { role: "user".into(), content: selection.clone() },
        ChatMessage { role: "assistant".into(), content: prior_result },
        ChatMessage { role: "user".into(), content: instruction.clone() },
    ];
    // Estimate based on selection + prior + instruction so followup output
    // has the same generous ceiling as the initial run.
    let estimated_input_tokens =
        (selection.chars().count() / 4 + selection.chars().count() / 4 + 50) as i64;
    let effective_max_tokens: i64 = match kind {
        RefineKind::Summarize => mode.max_tokens,
        _ => {
            let scaled = (estimated_input_tokens as f64 * 1.4).ceil() as i64;
            mode.max_tokens.max(scaled).min(16_000)
        }
    };
    let params = CompletionParams {
        model: None,
        temperature: Some(mode.temperature),
        max_tokens: Some(effective_max_tokens as u32),
        system: Some(system_prompt),
    };

    let cfg = state.connections.http_config().await;
    let _permit = state.connections.acquire_permit().await;
    let stream_pref = state
        .settings
        .get()
        .await
        .map(|s| s.stream_response)
        .unwrap_or(true);
    let result = if stream_pref {
        let app_for_tokens = app.clone();
        let app_for_cancel = app.clone();
        crate::providers::complete_stream(
            &row,
            messages,
            params,
            &cfg,
            move |delta| {
                if is_current_stream(&app_for_tokens, seq) {
                    let _ = app_for_tokens.emit("refine:token", delta);
                }
            },
            move || !is_current_stream(&app_for_cancel, seq),
        )
        .await?
    } else {
        let r = crate::providers::complete(&row, messages, params, &cfg).await?;
        if is_current_stream(&app, seq) {
            let _ = app.emit("refine:token", r.text.as_str());
        }
        r
    };

    state.connections.mark_used(&row.id).await;
    let cost_micros = crate::services::pricing::cost_micros(
        &result.model,
        result.usage.input_tokens as i64,
        result.usage.output_tokens as i64,
        row.price_input_per_m,
        row.price_output_per_m,
    );
    // Record the followup as its own history row. We keep the original
    // selection as `source_text` (so the row is still useful as "what did I
    // refine?") but prepend the user's instruction so the conversation is
    // reconstructable from history alone. Mode name carries a `· tweak`
    // suffix so the user can spot follow-ups vs initial runs at a glance.
    //
    // Same kind-aware fix as `run_stream`: Grammar / Summarize follow-ups
    // are tagged with the action the user actually performed, not the
    // active rewrite mode they happen to have selected.
    let (history_mode_name, history_icon) = match kind {
        RefineKind::Rewrite => (
            format!("{} · tweak", mode.name),
            mode.icon_name.clone(),
        ),
        other => (
            format!("{} · tweak", other.label()),
            other.icon().to_string(),
        ),
    };
    let combined_source = format!("[Tweak: {instruction}]\n\n{selection}");
    let _ = state
        .history
        .record(crate::models::NewHistoryItem {
            mode_name: history_mode_name,
            icon_name: history_icon,
            provider_label: format!("{} · {}", row.label, result.model),
            source_text: combined_source,
            output_text: result.text.clone(),
            latency_ms: result.latency_ms as i64,
            input_tokens: result.usage.input_tokens as i64,
            output_tokens: result.usage.output_tokens as i64,
            cost_micros,
        })
        .await;

    if is_current_stream(&app, seq) {
        if let Some(s) = app.try_state::<RefineSession>() {
            *s.last_result.lock().unwrap() = Some(result.text.clone());
        }
        let _ = app.emit("refine:done", &result);
    }
    Ok(())
}

/// Switch the active session to a different connection mid-overlay (the
/// "Run this against Claude instead" use case). Sets the override on the
/// session and immediately re-fires the prompt — same logic as `retry`
/// but the resolved connection now reads through the override.
pub async fn switch_connection(app: AppHandle, conn_id: String) -> AppResult<()> {
    let conn_id = conn_id.trim().to_string();
    if conn_id.is_empty() {
        return Err(AppError::Validation("connection id is empty".into()));
    }
    {
        let session = app
            .try_state::<RefineSession>()
            .ok_or_else(|| AppError::Config("RefineSession not initialized".into()))?;
        *session.connection_override.lock().unwrap() = Some(conn_id);
    }
    retry(app).await
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
    let kind = session
        .kind
        .lock()
        .unwrap()
        .unwrap_or(RefineKind::Rewrite);

    let seq = session.stream_seq.fetch_add(1, Ordering::SeqCst) + 1;

    let _ = app.emit("refine:reset_text", ());
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_stream(app2.clone(), kind, mode_id, selection, seq).await {
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
        *session.last_result.lock().unwrap() = None;
        *session.connection_override.lock().unwrap() = None;
    }
}
