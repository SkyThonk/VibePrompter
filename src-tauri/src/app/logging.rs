//! `tracing` initialization — a rolling daily file appender plus a console layer
//! in debug builds. Replaces `tauri-plugin-log` as the single logging stack.

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::config::Config;

/// Initialize the global tracing subscriber.
///
/// Returns a `WorkerGuard` that MUST be kept alive for the lifetime of the
/// process — dropping it stops the background log-writing thread.
pub fn init(config: &Config) -> WorkerGuard {
    let file_appender = tracing_appender::rolling::daily(&config.log_dir, "vibeprompter.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&config.log_level));

    let file_layer = fmt::layer().with_ansi(false).with_writer(non_blocking);

    let registry = tracing_subscriber::registry().with(filter).with(file_layer);

    if config.debug_mode {
        registry.with(fmt::layer().with_ansi(true)).init();
    } else {
        registry.init();
    }

    tracing::info!("logging initialized (level={})", config.log_level);
    guard
}
