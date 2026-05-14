//! The application-wide event contract. `AppEvent` enumerates every event the
//! backend can emit. Foundation emits `AppReady`, `SettingsChanged`, and
//! `ShortcutUpdated`; the rest are typed-but-dormant until sub-projects 2/3.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ShortcutTriggeredPayload {
    pub shortcut_id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiRequestPayload {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamChunkPayload {
    pub request_id: String,
    pub chunk: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiRequestFailedPayload {
    pub request_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModeChangedPayload {
    pub mode_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderChangedPayload {
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClipboardOperationPayload {
    pub operation: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverlayOpenedPayload {
    pub overlay_kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShortcutUpdatedPayload {
    pub shortcut_id: String,
}

/// Every event the backend can emit. The associated `name()` is the stable
/// string the frontend listens on.
#[derive(Debug, Clone)]
pub enum AppEvent {
    AppReady,
    SettingsChanged,
    ShortcutUpdated(ShortcutUpdatedPayload),
    // Dormant — emitted by later sub-projects.
    ShortcutTriggered(ShortcutTriggeredPayload),
    AiRequestStarted(AiRequestPayload),
    AiStreamChunk(AiStreamChunkPayload),
    AiRequestCompleted(AiRequestPayload),
    AiRequestFailed(AiRequestFailedPayload),
    ModeChanged(ModeChangedPayload),
    ProviderChanged(ProviderChangedPayload),
    ClipboardOperation(ClipboardOperationPayload),
    OverlayOpened(OverlayOpenedPayload),
}

impl AppEvent {
    /// The stable event-name string emitted over the Tauri event channel.
    pub fn name(&self) -> &'static str {
        match self {
            AppEvent::AppReady => "app_ready",
            AppEvent::SettingsChanged => "settings_changed",
            AppEvent::ShortcutUpdated(_) => "shortcut_updated",
            AppEvent::ShortcutTriggered(_) => "shortcut_triggered",
            AppEvent::AiRequestStarted(_) => "ai_request_started",
            AppEvent::AiStreamChunk(_) => "ai_stream_chunk",
            AppEvent::AiRequestCompleted(_) => "ai_request_completed",
            AppEvent::AiRequestFailed(_) => "ai_request_failed",
            AppEvent::ModeChanged(_) => "mode_changed",
            AppEvent::ProviderChanged(_) => "provider_changed",
            AppEvent::ClipboardOperation(_) => "clipboard_operation",
            AppEvent::OverlayOpened(_) => "overlay_opened",
        }
    }

    /// The JSON payload for this event (`null` for payload-less events).
    pub fn payload(&self) -> serde_json::Value {
        match self {
            AppEvent::AppReady | AppEvent::SettingsChanged => serde_json::Value::Null,
            AppEvent::ShortcutUpdated(p) => serde_json::to_value(p).unwrap_or_default(),
            AppEvent::ShortcutTriggered(p) => serde_json::to_value(p).unwrap_or_default(),
            AppEvent::AiRequestStarted(p) | AppEvent::AiRequestCompleted(p) => {
                serde_json::to_value(p).unwrap_or_default()
            }
            AppEvent::AiStreamChunk(p) => serde_json::to_value(p).unwrap_or_default(),
            AppEvent::AiRequestFailed(p) => serde_json::to_value(p).unwrap_or_default(),
            AppEvent::ModeChanged(p) => serde_json::to_value(p).unwrap_or_default(),
            AppEvent::ProviderChanged(p) => serde_json::to_value(p).unwrap_or_default(),
            AppEvent::ClipboardOperation(p) => serde_json::to_value(p).unwrap_or_default(),
            AppEvent::OverlayOpened(p) => serde_json::to_value(p).unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_are_stable() {
        assert_eq!(AppEvent::AppReady.name(), "app_ready");
        assert_eq!(AppEvent::SettingsChanged.name(), "settings_changed");
        assert_eq!(
            AppEvent::ShortcutUpdated(ShortcutUpdatedPayload { shortcut_id: "x".into() }).name(),
            "shortcut_updated"
        );
    }

    #[test]
    fn payload_carries_struct_fields() {
        let ev = AppEvent::ShortcutUpdated(ShortcutUpdatedPayload { shortcut_id: "palette".into() });
        assert_eq!(ev.payload()["shortcut_id"], "palette");
    }
}
