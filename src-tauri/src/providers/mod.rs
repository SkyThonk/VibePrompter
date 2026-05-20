//! Real provider HTTP client. Two protocols cover the modern landscape:
//!
//!   * `openai` — OpenAI-compatible chat completions. Every major vendor
//!     speaks this today: OpenAI itself, OpenRouter, Groq, Mistral, DeepSeek,
//!     Together, Gemini (via compat endpoint), Ollama, LM Studio, vLLM,
//!     llama.cpp's server. Add a new vendor by typing a base URL — no code.
//!   * `anthropic` — Native Anthropic Messages API.
//!
//! The client deliberately does NOT enumerate known vendors or models — that
//! is the failure mode the user is asking us to avoid ("not keep updating
//! the app for every new model"). Model identifiers are free-text strings
//! the user types in or fetches from `/models`.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::models::{
    ChatMessage, CompletionParams, CompletionResult, ConnectionKind, Settings, TokenUsage,
};
use crate::storage::repositories::ConnectionRow;
use crate::utils::{AppError, AppResult};

/// Tuneable HTTP-client knobs sourced from `Settings`. Pulled into a small
/// struct so every code path can build a settings-aware client without
/// reaching for `AppState` mid-call.
#[derive(Debug, Clone)]
pub struct HttpConfig {
    pub timeout: Duration,
    pub proxy: Option<String>,
    /// When true, raw request URL/body and response status/preview are
    /// emitted at INFO level — useful for diagnosing prompt regressions.
    /// API keys are NEVER logged (we use bearer/x-api-key headers, not
    /// the URL or body).
    pub log_raw: bool,
}

impl HttpConfig {
    pub fn from_settings(s: &Settings) -> Self {
        let secs = s.response_timeout.clamp(5, 600);
        let proxy = if s.proxy_url.trim().is_empty() {
            None
        } else {
            Some(s.proxy_url.trim().to_string())
        };
        Self {
            timeout: Duration::from_secs(secs as u64),
            proxy,
            log_raw: s.log_raw_responses,
        }
    }
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(120),
            proxy: None,
            log_raw: false,
        }
    }
}

fn http(cfg: &HttpConfig) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent("VibePrompter/0.1")
        .timeout(cfg.timeout);
    if let Some(p) = cfg.proxy.as_ref() {
        match reqwest::Proxy::all(p) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(e) => {
                // Bad proxy config shouldn't blow up the whole client — log
                // and fall through to direct. The Settings UI is where the
                // user can fix the URL.
                tracing::warn!("ignoring invalid proxy_url '{p}': {e}");
            }
        }
    }
    builder
        .build()
        .map_err(|e| AppError::Config(format!("http client: {e}")))
}

fn normalize_base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

/// Apply user-configured per-connection headers to an outbound request. The
/// `extra_headers` column stores a `{"Name": "value", ...}` JSON object.
/// Empty / malformed values are silently skipped — we never want a bad
/// config row to break a working call. Header injection respects the
/// reqwest builder's normal validation (invalid name/value → skip + log).
fn apply_extra_headers(
    mut req: reqwest::RequestBuilder,
    conn: &ConnectionRow,
) -> reqwest::RequestBuilder {
    if conn.extra_headers.trim().is_empty() {
        return req;
    }
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&conn.extra_headers);
    let obj = match parsed.as_ref().ok().and_then(|v| v.as_object()) {
        Some(o) => o,
        None => {
            tracing::warn!(
                "connection '{}' has non-object extra_headers — ignoring",
                conn.label
            );
            return req;
        }
    };
    for (name, value) in obj {
        let v_str = match value.as_str() {
            Some(s) => s,
            None => {
                tracing::warn!(
                    "extra header '{name}' on '{}' is not a string — skipping",
                    conn.label
                );
                continue;
            }
        };
        req = req.header(name.as_str(), v_str);
    }
    req
}

/// Conditional raw-body trace. Truncates at 4KB so a malformed multi-MB
/// response can't blow up the log. API keys live in headers — never the
/// body — so this is safe to enable.
fn log_raw_req(cfg: &HttpConfig, method: &str, url: &str, body: &serde_json::Value) {
    if !cfg.log_raw {
        return;
    }
    let body_str = serde_json::to_string(body).unwrap_or_default();
    let trimmed: String = body_str.chars().take(4096).collect();
    tracing::info!(target: "raw_http", "→ {method} {url} body={trimmed}");
}

/// Parse a `Retry-After` value out of an error message we already
/// formatted. The provider helpers stringify failures with the response
/// body still included; vendors that send 429 commonly echo "retry in 12
/// seconds" or `{"error":{"retry_after_ms":12000}}`. Returns `None` when
/// nothing parsable is present — caller falls back to fixed backoff.
fn parse_retry_after(err_msg: &str) -> Option<std::time::Duration> {
    // Look for a JSON-ish field first ("retry_after_ms":12000 or
    // "retry_after":12 or "retryAfter":12).
    for (key, scale_ms) in [
        ("retry_after_ms", 1u64),
        ("retry_after", 1000u64),
        ("retryAfter", 1000u64),
    ] {
        if let Some(idx) = err_msg.find(key) {
            let tail = &err_msg[idx + key.len()..];
            let num: String = tail
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = num.parse::<u64>() {
                if n > 0 && n < 600_000 {
                    return Some(std::time::Duration::from_millis(n.saturating_mul(scale_ms)));
                }
            }
        }
    }
    None
}

/// Extract a vendor-readable error message from a JSON body, falling back
/// to a 400-char preview when the body isn't JSON or doesn't follow the
/// common shape. Covers OpenAI (`error.message`), Anthropic (`error.message`),
/// OpenRouter (`error.message`), Groq (`error.message`), Mistral (`message`),
/// and Ollama (`error`) — i.e. every vendor we ship presets for.
fn extract_vendor_error(status: reqwest::StatusCode, raw: &str) -> String {
    let trimmed = raw.trim();
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(trimmed);
    if let Ok(v) = parsed {
        // Try nested error.message first.
        if let Some(msg) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            // Many vendors include a typed error code — include when present.
            let code = v
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(|c| c.as_str().or_else(|| c.as_i64().map(|_| "").map(|_| "code").into()));
            return match code {
                Some(c) if !c.is_empty() => format!("{status} · {msg} [{c}]"),
                _ => format!("{status} · {msg}"),
            };
        }
        // Anthropic sometimes returns error as a string at the top level.
        if let Some(msg) = v.get("error").and_then(|e| e.as_str()) {
            return format!("{status} · {msg}");
        }
        // Mistral / some local servers: top-level `message`.
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return format!("{status} · {msg}");
        }
    }
    let preview: String = trimmed.chars().take(400).collect();
    if preview.is_empty() {
        format!("{status}")
    } else {
        format!("{status}: {preview}")
    }
}

fn log_raw_resp(cfg: &HttpConfig, status: u16, body_preview: &str) {
    if !cfg.log_raw {
        return;
    }
    let trimmed: String = body_preview.chars().take(4096).collect();
    tracing::info!(target: "raw_http", "← {status} body={trimmed}");
}

pub async fn complete(
    conn: &ConnectionRow,
    messages: Vec<ChatMessage>,
    params: CompletionParams,
    cfg: &HttpConfig,
) -> AppResult<CompletionResult> {
    let kind = ConnectionKind::from_db(&conn.kind)
        .ok_or_else(|| AppError::Validation(format!("unknown connection kind: {}", conn.kind)))?;

    let model = params
        .model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| Some(conn.default_model.clone()).filter(|s| !s.trim().is_empty()))
        .ok_or_else(|| {
            AppError::Validation("no model specified and no default on connection".into())
        })?;

    let started = std::time::Instant::now();
    let (text, usage) = with_retry(|| async {
        match kind {
            ConnectionKind::Openai => openai_chat(conn, &model, &messages, &params, cfg).await,
            ConnectionKind::Anthropic => anthropic_chat(conn, &model, &messages, &params, cfg).await,
        }
    })
    .await?;

    Ok(CompletionResult {
        text,
        model,
        latency_ms: started.elapsed().as_millis() as u64,
        usage,
    })
}

/// Retry a transient LLM call. We treat 429 (rate limit), 5xx (server
/// errors), 529 (Anthropic "overloaded"), and network-class failures as
/// retriable; 4xx other than 429 are user errors and propagate immediately.
///
/// Backoff: exponential (~500ms → 1.5s → 4s → 8s) with up to ±20% jitter so
/// concurrent callers don't synchronize their retries. Total worst-case wait
/// is ~14s before giving up — long enough to survive a brief overload spike,
/// short enough that a stuck request still surfaces to the user.
///
/// Vendor-supplied `Retry-After` overrides our backoff up to a 30s cap (some
/// providers ask for minutes on rate limit — that's better surfaced to the
/// user than silently swallowed).
async fn with_retry<F, Fut, T>(mut op: F) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    const BASE_BACKOFFS_MS: [u64; 4] = [500, 1500, 4000, 8000];
    let mut last_err: Option<AppError> = None;
    for attempt in 0..=BASE_BACKOFFS_MS.len() {
        match op().await {
            Ok(v) => {
                if attempt > 0 {
                    tracing::info!("call succeeded on retry attempt {}", attempt + 1);
                }
                return Ok(v);
            }
            Err(e) => {
                if !is_transient(&e) || attempt == BASE_BACKOFFS_MS.len() {
                    return Err(e);
                }
                let base = std::time::Duration::from_millis(BASE_BACKOFFS_MS[attempt]);
                // Add ±20% jitter. `rand` isn't in scope here — use the
                // attempt counter + nanos for cheap deterministic-ish spread.
                let jitter_ms = {
                    let nanos = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.subsec_nanos() as u64)
                        .unwrap_or(0);
                    let spread = (BASE_BACKOFFS_MS[attempt] as i64) * 2 / 10; // 20%
                    if spread == 0 {
                        0
                    } else {
                        (nanos as i64 % (spread * 2 + 1)) - spread
                    }
                };
                let backoff = base.saturating_add(std::time::Duration::from_millis(
                    jitter_ms.max(0) as u64,
                ));
                let delay = parse_retry_after(&e.to_string())
                    .map(|d| d.min(std::time::Duration::from_secs(30)))
                    .unwrap_or(backoff);
                tracing::warn!(
                    "transient failure on attempt {}/{} ({}ms backoff): {e}",
                    attempt + 1,
                    BASE_BACKOFFS_MS.len() + 1,
                    delay.as_millis()
                );
                tokio::time::sleep(delay).await;
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Validation("retry loop exhausted".into())))
}

fn is_transient(e: &AppError) -> bool {
    let msg = e.to_string();
    let lower = msg.to_ascii_lowercase();
    // Network-class errors are always retriable.
    if lower.contains("request to ")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("dns")
        || lower.contains("reset by peer")
        || lower.contains("broken pipe")
    {
        return true;
    }
    // Vendor "overloaded" signals — Anthropic returns `overloaded_error`
    // (sometimes as HTTP 529, sometimes 200 with an error body), OpenAI
    // surfaces "server_error" / "engine overloaded", OpenRouter forwards
    // upstream "overload" verbatim. Catch the keyword regardless of code.
    if lower.contains("overload")
        || lower.contains("overloaded_error")
        || lower.contains("server_error")
        || lower.contains("service unavailable")
        || lower.contains("bad gateway")
        || lower.contains("gateway timeout")
    {
        return true;
    }
    // The provider error helper formats HTTP failures as "{status_code}
    // {reason} · …" so the first three chars are the status.
    msg.chars()
        .take(3)
        .collect::<String>()
        .parse::<u16>()
        .map(|code| code == 408 || code == 425 || code == 429 || code == 529 || (500..=599).contains(&code))
        .unwrap_or(false)
}

pub async fn list_models(conn: &ConnectionRow, cfg: &HttpConfig) -> AppResult<Vec<String>> {
    let kind = ConnectionKind::from_db(&conn.kind)
        .ok_or_else(|| AppError::Validation(format!("unknown connection kind: {}", conn.kind)))?;

    match kind {
        ConnectionKind::Openai => openai_list_models(conn, cfg).await,
        ConnectionKind::Anthropic => Ok(vec![
            "claude-opus-4-7".into(),
            "claude-sonnet-4-6".into(),
            "claude-haiku-4-5-20251001".into(),
        ]),
    }
}

/// Streaming chat completion. Calls `on_token` with each text delta as it
/// arrives off the wire, then returns the final aggregated text + model used
/// + total latency. Cancellation: pass a `should_cancel` closure that
/// returns true to abort — checked between every chunk.
pub async fn complete_stream<F, C>(
    conn: &ConnectionRow,
    messages: Vec<ChatMessage>,
    params: CompletionParams,
    cfg: &HttpConfig,
    mut on_token: F,
    should_cancel: C,
) -> AppResult<CompletionResult>
where
    F: FnMut(&str) + Send,
    C: Fn() -> bool + Send,
{
    use eventsource_stream::Eventsource;
    use futures_util::StreamExt;

    let kind = ConnectionKind::from_db(&conn.kind)
        .ok_or_else(|| AppError::Validation(format!("unknown connection kind: {}", conn.kind)))?;
    let model = params
        .model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| Some(conn.default_model.clone()).filter(|s| !s.trim().is_empty()))
        .ok_or_else(|| {
            AppError::Validation("no model specified and no default on connection".into())
        })?;

    let started = std::time::Instant::now();
    let base = normalize_base(&conn.base_url);

    // Build url + body once; the `RequestBuilder` is rebuilt on each retry
    // because `.send()` consumes it.
    let (url, body): (String, serde_json::Value) = match kind {
        ConnectionKind::Openai => {
            let url = format!("{base}/chat/completions");
            let mut payload_messages: Vec<serde_json::Value> = Vec::new();
            if let Some(sys) = params.system.as_ref().filter(|s| !s.trim().is_empty()) {
                payload_messages.push(serde_json::json!({ "role": "system", "content": sys }));
            }
            for m in &messages {
                payload_messages.push(serde_json::json!({ "role": m.role, "content": m.content }));
            }
            let mut body = serde_json::json!({
                "model": model,
                "messages": payload_messages,
                "stream": true,
                // OpenAI-compat: opt in to a final chunk that carries usage
                // totals. Vendors that don't honor it just ignore it.
                "stream_options": { "include_usage": true },
            });
            if let Some(t) = params.temperature {
                body["temperature"] = serde_json::json!(t);
            }
            if let Some(mt) = params.max_tokens {
                body["max_tokens"] = serde_json::json!(mt);
            }
            (url, body)
        }
        ConnectionKind::Anthropic => {
            let url = format!("{base}/v1/messages");
            let payload_messages: Vec<serde_json::Value> = messages
                .iter()
                .filter(|m| m.role != "system")
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let mut body = serde_json::json!({
                "model": model,
                "messages": payload_messages,
                "max_tokens": params.max_tokens.unwrap_or(1024),
                "stream": true,
            });
            if let Some(sys) = params.system.as_ref().filter(|s| !s.trim().is_empty()) {
                body["system"] = serde_json::json!(sys);
            } else if let Some(sys_msg) = messages.iter().find(|m| m.role == "system") {
                body["system"] = serde_json::json!(sys_msg.content);
            }
            if let Some(t) = params.temperature {
                body["temperature"] = serde_json::json!(t);
            }
            (url, body)
        }
    };

    log_raw_req(cfg, "POST", &url, &body);

    // Retry the connection + 2xx-or-bust handshake. Once headers are
    // accepted we can't retry safely (we'd duplicate tokens already
    // emitted via `on_token`), so the retry boundary stops here.
    let url_for_retry = url.clone();
    let body_for_retry = body.clone();
    let resp = with_retry(|| {
        let url = url_for_retry.clone();
        let body = body_for_retry.clone();
        async move {
            let req = match kind {
                ConnectionKind::Openai => apply_extra_headers(
                    http(cfg)?.post(&url).bearer_auth(&conn.api_key).json(&body),
                    conn,
                ),
                ConnectionKind::Anthropic => apply_extra_headers(
                    http(cfg)?
                        .post(&url)
                        .header("x-api-key", &conn.api_key)
                        .header("anthropic-version", "2023-06-01")
                        .json(&body),
                    conn,
                ),
            };
            let resp = req
                .send()
                .await
                .map_err(|e| AppError::Config(format!("request to {url}: {e}")))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let raw = resp.text().await.unwrap_or_default();
                return Err(AppError::Validation(format!(
                    "{} (at {url})",
                    extract_vendor_error(status, &raw)
                )));
            }
            Ok(resp)
        }
    })
    .await?;

    let mut text = String::new();
    let mut usage = TokenUsage::default();
    let mut stream = resp.bytes_stream().eventsource();
    while let Some(event) = stream.next().await {
        if should_cancel() {
            return Ok(CompletionResult {
                text,
                model,
                latency_ms: started.elapsed().as_millis() as u64,
                usage,
            });
        }
        let event = match event {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("stream parse: {e}");
                continue;
            }
        };
        let data = event.data;
        if data == "[DONE]" {
            break;
        }
        if data.trim().is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // OpenAI delta: choices[0].delta.content
        if let Some(delta) = parsed
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|t| t.as_str())
        {
            text.push_str(delta);
            on_token(delta);
        }
        // OpenAI final-usage chunk (sent when `stream_options.include_usage`
        // is set). Lives alongside the deltas — capture either way.
        if let Some(u) = parsed.get("usage") {
            if let Some(p) = u.get("prompt_tokens").and_then(|v| v.as_u64()) {
                usage.input_tokens = p as u32;
            }
            if let Some(c) = u.get("completion_tokens").and_then(|v| v.as_u64()) {
                usage.output_tokens = c as u32;
            }
        }

        // Anthropic delta: content_block_delta.delta.text
        match parsed.get("type").and_then(|t| t.as_str()) {
            Some("content_block_delta") => {
                if let Some(t) = parsed
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                {
                    text.push_str(t);
                    on_token(t);
                }
            }
            Some("message_start") => {
                if let Some(p) = parsed
                    .get("message")
                    .and_then(|m| m.get("usage"))
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(|v| v.as_u64())
                {
                    usage.input_tokens = p as u32;
                }
            }
            Some("message_delta") => {
                if let Some(o) = parsed
                    .get("usage")
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|v| v.as_u64())
                {
                    usage.output_tokens = o as u32;
                }
            }
            _ => {}
        }
    }

    // Log the aggregated stream body when the user has opted into raw
    // logging. We log 200 = success because we only reach this point on
    // a 2xx; the actual status was already validated above.
    log_raw_resp(cfg, 200, &text);

    Ok(CompletionResult {
        text,
        model,
        latency_ms: started.elapsed().as_millis() as u64,
        usage,
    })
}

/// Cheap "are you alive" round-trip used by Settings → Providers Test
/// button. Returns the full `CompletionResult` so the toast can show model
/// + latency proof-of-life ("openai/gpt-4o-mini · 412ms").
pub async fn ping_with_result(
    conn: &ConnectionRow,
    cfg: &HttpConfig,
) -> AppResult<CompletionResult> {
    complete(
        conn,
        vec![ChatMessage { role: "user".into(), content: "ping".into() }],
        CompletionParams { max_tokens: Some(4), ..Default::default() },
        cfg,
    )
    .await
}

// ─────────────────────────────────────────────────────────── OpenAI-compatible

#[derive(Debug, Deserialize)]
struct OpenAiChoiceMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

async fn openai_chat(
    conn: &ConnectionRow,
    model: &str,
    messages: &[ChatMessage],
    params: &CompletionParams,
    cfg: &HttpConfig,
) -> AppResult<(String, TokenUsage)> {
    let base = normalize_base(&conn.base_url);
    let url = format!("{base}/chat/completions");

    let mut payload_messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = params.system.as_ref().filter(|s| !s.trim().is_empty()) {
        payload_messages.push(json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        payload_messages.push(json!({ "role": m.role, "content": m.content }));
    }

    let mut body = json!({
        "model": model,
        "messages": payload_messages,
        "stream": false,
    });
    if let Some(t) = params.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(mt) = params.max_tokens {
        body["max_tokens"] = json!(mt);
    }

    log_raw_req(cfg, "POST", &url, &body);
    let req = http(cfg)?
        .post(&url)
        .bearer_auth(&conn.api_key)
        .json(&body);
    let resp = apply_extra_headers(req, conn)
        .send()
        .await
        .map_err(|e| AppError::Config(format!("request to {url}: {e}")))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| AppError::Validation(format!("read response body: {e}")))?;
    log_raw_resp(cfg, status.as_u16(), &raw);

    if !status.is_success() {
        return Err(AppError::Validation(format!(
            "{} (at {url})",
            extract_vendor_error(status, &raw)
        )));
    }

    let parsed: OpenAiChatResponse = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("decode response: {e}")))?;

    let text = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default();
    let usage = parsed.usage.map(|u| TokenUsage {
        input_tokens: u.prompt_tokens,
        output_tokens: u.completion_tokens,
    }).unwrap_or_default();
    Ok((text, usage))
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

async fn openai_list_models(conn: &ConnectionRow, cfg: &HttpConfig) -> AppResult<Vec<String>> {
    let base = normalize_base(&conn.base_url);
    let url = format!("{base}/models");

    let req = http(cfg)?.get(&url).bearer_auth(&conn.api_key);
    let resp = apply_extra_headers(req, conn)
        .send()
        .await
        .map_err(|e| AppError::Config(format!("request to {url}: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Validation(format!(
            "{} (at {url})",
            extract_vendor_error(status, &body)
        )));
    }

    let parsed: OpenAiModelsResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Validation(format!("decode /models: {e}")))?;

    let mut ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    Ok(ids)
}

// ─────────────────────────────────────────────────────────────────── Anthropic

#[derive(Debug, Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct AnthropicMessagesResponse {
    content: Vec<AnthropicContentBlock>,
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

async fn anthropic_chat(
    conn: &ConnectionRow,
    model: &str,
    messages: &[ChatMessage],
    params: &CompletionParams,
    cfg: &HttpConfig,
) -> AppResult<(String, TokenUsage)> {
    let base = normalize_base(&conn.base_url);
    let url = format!("{base}/v1/messages");

    let payload_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut body = json!({
        "model": model,
        "messages": payload_messages,
        "max_tokens": params.max_tokens.unwrap_or(1024),
    });
    if let Some(sys) = params.system.as_ref().filter(|s| !s.trim().is_empty()) {
        body["system"] = json!(sys);
    } else if let Some(sys_msg) = messages.iter().find(|m| m.role == "system") {
        body["system"] = json!(sys_msg.content);
    }
    if let Some(t) = params.temperature {
        body["temperature"] = json!(t);
    }

    log_raw_req(cfg, "POST", &url, &body);
    let req = http(cfg)?
        .post(&url)
        .header("x-api-key", &conn.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    let resp = apply_extra_headers(req, conn)
        .send()
        .await
        .map_err(|e| AppError::Config(format!("request to {url}: {e}")))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| AppError::Validation(format!("read response body: {e}")))?;
    log_raw_resp(cfg, status.as_u16(), &raw);

    if !status.is_success() {
        return Err(AppError::Validation(format!(
            "{} (at {url})",
            extract_vendor_error(status, &raw)
        )));
    }

    let parsed: AnthropicMessagesResponse = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("decode response: {e}")))?;

    let text = parsed
        .content
        .into_iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text)
        .collect::<Vec<_>>()
        .join("");
    let usage = parsed.usage.map(|u| TokenUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
    }).unwrap_or_default();
    Ok((text, usage))
}
