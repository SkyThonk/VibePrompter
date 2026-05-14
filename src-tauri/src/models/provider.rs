//! Provider read DTO. `accent` and `local` are pulled out of the stored `extra`
//! JSON to match the frontend `ProviderInfo` interface.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub accent: String,
    /// "ok" when enabled, "idle" otherwise (Foundation has no live status check).
    pub status: String,
    pub model: String,
    /// Token usage — always 0 until sub-project 2 records real usage.
    pub usage: i64,
    pub local: bool,
}
