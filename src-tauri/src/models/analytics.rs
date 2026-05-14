//! Analytics event struct. The write path is owned by sub-project 3 — this
//! struct exists now so the `analytics` table has a typed counterpart.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct AnalyticsEvent {
    pub event_type: String,
    pub payload: serde_json::Value,
}
