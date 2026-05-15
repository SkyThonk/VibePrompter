//! Repositories — each owns the SQL for one table.

pub mod connection_repo;
pub mod history_repo;
pub mod mode_repo;
pub mod provider_repo;
pub mod settings_repo;
pub mod shortcut_repo;

pub use connection_repo::{ConnectionRepo, ConnectionRow};
pub use history_repo::HistoryRepo;
pub use mode_repo::ModeRepo;
pub use provider_repo::ProviderRepo;
pub use settings_repo::SettingsRepo;
pub use shortcut_repo::ShortcutRepo;
