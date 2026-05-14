//! History records. `HistoryItem` is the read DTO sent to the frontend; field
//! names match the frontend `HistoryItem` interface.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct HistoryItem {
    pub id: i64,
    #[serde(rename = "mode")]
    pub mode_name: String,
    #[serde(rename = "iconName")]
    pub icon_name: String,
    #[serde(rename = "provider")]
    pub provider_label: String,
    #[serde(rename = "src")]
    pub source_text: String,
    #[serde(rename = "out")]
    pub output_text: String,
    #[serde(rename = "ms")]
    pub latency_ms: i64,
    #[serde(rename = "fav")]
    pub favorite: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Input for inserting a new history record (used by sub-project 2).
#[derive(Debug, Clone)]
pub struct NewHistoryItem {
    pub mode_name: String,
    pub icon_name: String,
    pub provider_label: String,
    pub source_text: String,
    pub output_text: String,
    pub latency_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 { 100 }

impl Default for HistoryQuery {
    fn default() -> Self {
        Self { limit: default_limit(), offset: 0 }
    }
}
