//! Service layer — business logic, orchestrating repositories and the event bus.

pub mod catalog_service;
pub mod connection_service;
pub mod history_service;
pub mod prompt_service;
pub mod settings_service;
pub mod shortcut_service;

pub use catalog_service::CatalogService;
pub use connection_service::ConnectionService;
pub use history_service::HistoryService;
pub use prompt_service::PromptService;
pub use settings_service::SettingsService;
pub use shortcut_service::ShortcutService;
