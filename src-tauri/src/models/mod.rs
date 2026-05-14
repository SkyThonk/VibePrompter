//! Domain models and serde DTOs shared across all layers.

pub mod analytics;
pub mod history;
pub mod prompt_mode;
pub mod provider;
pub mod settings;
pub mod shortcut;

pub use history::{HistoryItem, HistoryQuery, NewHistoryItem};
pub use prompt_mode::PromptMode;
pub use provider::ProviderInfo;
pub use settings::Settings;
pub use shortcut::{ShortcutConfig, ShortcutItem};
