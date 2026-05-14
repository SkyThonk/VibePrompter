//! Shortcut config. `ShortcutItem` is the read DTO; `keys` is derived from the
//! stored `accelerator` string to match the frontend `ShortcutItem` interface.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ShortcutItem {
    pub id: String,
    pub label: String,
    pub hint: String,
    #[serde(rename = "iconName")]
    pub icon_name: String,
    pub accelerator: String,
    pub action: String,
    pub enabled: bool,
    /// Derived from `accelerator` (e.g. "Ctrl+Shift+Space" -> ["Ctrl","Shift","Space"]).
    #[serde(rename = "keys")]
    #[sqlx(skip)]
    pub keys: Vec<String>,
}

impl ShortcutItem {
    /// Populate the derived `keys` field from `accelerator`.
    pub fn with_keys(mut self) -> Self {
        self.keys = self.accelerator.split('+').map(|s| s.trim().to_string()).collect();
        self
    }
}

/// Input for registering/updating a shortcut.
#[derive(Debug, Clone, Deserialize)]
pub struct ShortcutConfig {
    pub id: String,
    pub label: String,
    pub hint: String,
    #[serde(rename = "iconName")]
    pub icon_name: String,
    pub accelerator: String,
    pub action: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i64,
}

fn default_enabled() -> bool { true }
