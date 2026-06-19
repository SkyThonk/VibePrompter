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
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    /// Per-run cost in micro-dollars (1 USD = 1_000_000). 0 = unknown
    /// (local model, missing usage from the vendor, or unrecognized model id).
    #[serde(rename = "costMicros")]
    pub cost_micros: i64,
    /// Thread root for tweaks/followups. `None` = a top-level refine; `Some(id)`
    /// = a tweak whose `id` points at the originating refine's row.
    #[serde(rename = "parentId")]
    pub parent_id: Option<i64>,
}

/// Input for inserting a new history record (used by sub-project 2).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct NewHistoryItem {
    pub mode_name: String,
    pub icon_name: String,
    pub provider_label: String,
    pub source_text: String,
    pub output_text: String,
    pub latency_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_micros: i64,
    /// `None` for a top-level refine; `Some(root_id)` for a tweak/followup.
    pub parent_id: Option<i64>,
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
