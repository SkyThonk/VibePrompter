//! Tauri command handlers — thin IPC adapters. Business logic lives in `services`.

pub mod catalog;
pub mod connections;
pub mod history;
pub mod overlay;
pub mod settings;
pub mod shortcuts;

pub use catalog::*;
pub use connections::*;
pub use history::*;
pub use overlay::*;
pub use settings::*;
pub use shortcuts::*;
