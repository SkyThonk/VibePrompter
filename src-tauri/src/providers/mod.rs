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

use crate::models::{ChatMessage, CompletionParams, CompletionResult, ConnectionKind};
use crate::storage::repositories::ConnectionRow;
use crate::utils::{AppError, AppResult};

fn http() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("VibePrompter/0.1")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Config(format!("http client: {e}")))
}

fn normalize_base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

pub async fn complete(
    conn: &ConnectionRow,
    messages: Vec<ChatMessage>,
    params: CompletionParams,
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
    let text = match kind {
        ConnectionKind::Openai => openai_chat(conn, &model, &messages, &params).await?,
        ConnectionKind::Anthropic => anthropic_chat(conn, &model, &messages, &params).await?,
    };

    Ok(CompletionResult {
        text,
        model,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

pub async fn list_models(conn: &ConnectionRow) -> AppResult<Vec<String>> {
    let kind = ConnectionKind::from_db(&conn.kind)
        .ok_or_else(|| AppError::Validation(format!("unknown connection kind: {}", conn.kind)))?;

    match kind {
        ConnectionKind::Openai => openai_list_models(conn).await,
        ConnectionKind::Anthropic => Ok(vec![
            "claude-opus-4-7".into(),
            "claude-sonnet-4-6".into(),
            "claude-haiku-4-5-20251001".into(),
        ]),
    }
}

pub async fn ping(conn: &ConnectionRow) -> AppResult<()> {
    complete(
        conn,
        vec![ChatMessage { role: "user".into(), content: "ping".into() }],
        CompletionParams { max_tokens: Some(4), ..Default::default() },
    )
    .await
    .map(|_| ())
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
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
}

async fn openai_chat(
    conn: &ConnectionRow,
    model: &str,
    messages: &[ChatMessage],
    params: &CompletionParams,
) -> AppResult<String> {
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

    let resp = http()?
        .post(&url)
        .bearer_auth(&conn.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Config(format!("request to {url}: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Validation(format!(
            "{status} from {url}: {}",
            body.chars().take(400).collect::<String>()
        )));
    }

    let parsed: OpenAiChatResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Validation(format!("decode response: {e}")))?;

    Ok(parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default())
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

async fn openai_list_models(conn: &ConnectionRow) -> AppResult<Vec<String>> {
    let base = normalize_base(&conn.base_url);
    let url = format!("{base}/models");

    let resp = http()?
        .get(&url)
        .bearer_auth(&conn.api_key)
        .send()
        .await
        .map_err(|e| AppError::Config(format!("request to {url}: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Validation(format!(
            "{status} from {url}: {}",
            body.chars().take(400).collect::<String>()
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
struct AnthropicMessagesResponse {
    content: Vec<AnthropicContentBlock>,
}

async fn anthropic_chat(
    conn: &ConnectionRow,
    model: &str,
    messages: &[ChatMessage],
    params: &CompletionParams,
) -> AppResult<String> {
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

    let resp = http()?
        .post(&url)
        .header("x-api-key", &conn.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Config(format!("request to {url}: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Validation(format!(
            "{status} from {url}: {}",
            body.chars().take(400).collect::<String>()
        )));
    }

    let parsed: AnthropicMessagesResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Validation(format!("decode response: {e}")))?;

    Ok(parsed
        .content
        .into_iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text)
        .collect::<Vec<_>>()
        .join(""))
}
