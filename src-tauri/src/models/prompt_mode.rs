//! Prompt mode read DTO. Field renames match the frontend `PromptMode` interface
//! (`desc`, `sys`, `temp`, `maxTok`, `provider`).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
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
}
