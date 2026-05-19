//! The user-facing `Settings` aggregate. Serde field names match the frontend
//! settings keys; each field round-trips through one `settings` table row.

use serde::{Deserialize, Serialize};

/// Every field here is wired end-to-end somewhere in the backend or UI.
/// Don't add a field without also adding the behavior — the whole point of
/// the recent cleanup was to make this struct *truthful*.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    // Window / OS integration
    #[serde(default = "yes")]
    pub boot_start: bool,
    #[serde(default = "yes")]
    pub minimize_to_tray: bool,
    #[serde(default = "no")]
    pub quit_on_close: bool,
    #[serde(default = "yes")]
    pub notifications: bool,

    // AI runtime
    #[serde(default = "yes")]
    pub stream_response: bool,
    #[serde(default = "default_timeout")]
    pub response_timeout: u32,
    #[serde(default = "default_concurrent")]
    pub concurrent_requests: u32,
    #[serde(default)]
    pub proxy_url: String,

    // Appearance
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_accent")]
    pub accent: String,
    #[serde(default = "default_density")]
    pub density: String,

    // Data
    #[serde(default = "default_retention")]
    pub history_retention: String,

    // Developer
    #[serde(default = "no")]
    pub dev_tools: bool,
    #[serde(default = "no")]
    pub log_raw_responses: bool,
}

fn yes() -> bool { true }
fn no() -> bool { false }
fn default_timeout() -> u32 { 30 }
fn default_concurrent() -> u32 { 3 }
fn default_theme() -> String { "dark".into() }
fn default_accent() -> String { "violet".into() }
fn default_density() -> String { "regular".into() }
fn default_retention() -> String { "30d".into() }

impl Default for Settings {
    fn default() -> Self {
        // Round-trips an empty object through serde to apply every field default.
        serde_json::from_str("{}").expect("Settings default must deserialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_have_expected_values() {
        let s = Settings::default();
        assert!(s.boot_start);
        assert_eq!(s.response_timeout, 30);
        assert_eq!(s.theme, "dark");
        assert!(!s.quit_on_close);
    }
}
