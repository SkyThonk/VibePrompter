//! Tauri command handlers — thin IPC adapters. Business logic lives in `services`.

pub mod catalog;
pub mod history;
pub mod settings;
pub mod shortcuts;

pub use catalog::*;
pub use history::*;
pub use settings::*;
pub use shortcuts::*;
