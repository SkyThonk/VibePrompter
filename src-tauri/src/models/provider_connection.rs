//! User-owned provider connections. Each row is everything we need to make a
//! real API call: base URL, API key, default model, and the protocol kind so
//! we know how to format the request.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    /// Any OpenAI-compatible HTTP API. The user supplies `base_url` (e.g.
    /// `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`,
    /// `http://localhost:11434/v1`) and we POST to `{base_url}/chat/completions`.
    Openai,
    /// Native Anthropic Messages API at `{base_url}/v1/messages`.
    Anthropic,
}

impl ConnectionKind {
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "openai" => Some(ConnectionKind::Openai),
            "anthropic" => Some(ConnectionKind::Anthropic),
            _ => None,
        }
    }
}

/// Read DTO sent to the frontend. The `api_key` is intentionally redacted —
/// only the last 4 characters are exposed for display purposes. The full key
/// stays server-side, used directly by `ProviderClient`.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKeyTail")]
    pub api_key_tail: String,
    #[serde(rename = "hasKey")]
    pub has_key: bool,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

/// Write DTO from the frontend. `apiKey` is optional on update — when absent
/// or empty AND the row already has a key, we preserve the existing one so
/// the user can edit other fields without re-typing their secret.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub label: String,
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub is_default: bool,
}

/// A single message in a chat completion request — identical shape for both
/// OpenAI-compatible and Anthropic kinds; the client maps it onto each
/// vendor's wire format internally.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// Params passed alongside messages to `complete`. All optional — sensible
/// defaults at the client layer.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionParams {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub system: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompletionResult {
    pub text: String,
    pub model: String,
    #[serde(rename = "latencyMs")]
    pub latency_ms: u64,
}
