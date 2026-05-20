//! Prompt mode read DTO. Field renames match the frontend `PromptMode` interface
//! (`desc`, `sys`, `temp`, `maxTok`, `provider`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PromptMode {
    pub id: String,
    pub name: String,
    #[serde(rename = "desc")]
    pub description: String,
    #[serde(rename = "sys")]
    pub system_prompt: String,
    #[serde(rename = "temp")]
    pub temperature: f64,
    #[serde(rename = "maxTok")]
    pub max_tokens: i64,
    #[serde(rename = "provider")]
    #[sqlx(rename = "provider_override")]
    pub provider_override: Option<String>,
    #[serde(rename = "iconName")]
    pub icon_name: String,
    /// JSON object string of `{ "var": "default_value" }`. Substituted
    /// into `system_prompt` at call time wherever `{{var}}` appears.
    /// Empty `{}` when the mode declares no variables. We keep this as
    /// a serialized string at the model layer so it can flow through
    /// serde + sqlx without bespoke types — the frontend and the
    /// substitution helper parse it as JSON on demand.
    #[serde(default = "default_variables")]
    pub variables: String,
    /// Whether this mode appears in the tray menu, dashboard list, and the
    /// `cycle_mode` rotation. Disabled modes are still stored so the user can
    /// re-enable them later without losing their prompt + settings.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Built-in mode shipped with the app. Cannot be renamed or deleted from
    /// the UI; the repo also preserves this flag on every upsert so the
    /// frontend cannot promote a user mode to system or vice versa.
    #[serde(rename = "isSystem", default)]
    pub is_system: bool,
}

fn default_variables() -> String {
    "{}".to_string()
}

fn default_enabled() -> bool {
    true
}
