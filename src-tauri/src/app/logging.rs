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

    // `config.log_level` is a single token like "debug" or "info". A bare
    // "debug" applies to every crate in the dependency graph, drowning real
    // signal in per-query SQL noise. Add focused suppression for the loudest
    // dependencies so the resolved filter stays useful at the configured
    // level. Honors RUST_LOG when set — power users can still override.
    let resolved = format!(
        "{lvl},sqlx=warn,sqlx_core=warn,hyper=warn,reqwest=warn,tao=warn,wry=warn",
        lvl = config.log_level
    );
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&resolved));

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
