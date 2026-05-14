//! Service layer — business logic, orchestrating repositories and the event bus.

pub mod settings_service;

pub use settings_service::SettingsService;
