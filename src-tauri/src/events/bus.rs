//! `EventBus` — a thin typed wrapper over Tauri's `AppHandle` emit. Every
//! backend event goes through here so the contract has one chokepoint.

use tauri::{AppHandle, Emitter};

use super::types::AppEvent;

#[derive(Clone)]
pub struct EventBus {
    app_handle: AppHandle,
}

impl EventBus {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    /// Emit an event to all frontend listeners. Emit failures are logged, not
    /// propagated — a missing listener must never break a backend operation.
    pub fn emit(&self, event: AppEvent) {
        let name = event.name();
        if let Err(err) = self.app_handle.emit(name, event.payload()) {
            tracing::warn!("failed to emit event {name}: {err}");
        } else {
            tracing::debug!("emitted event {name}");
        }
    }
}
