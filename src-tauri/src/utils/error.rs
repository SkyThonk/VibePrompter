//! Centralized typed error system. `AppError` is the single error type for the
//! whole backend. It serializes to a sanitized `{ code, message, retriable }`
//! shape so SQL text and file paths never cross the IPC boundary.

use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    /// Configuration errors. The `String` is NOT passed to the wire (`safe_message`
    /// returns a generic message), but it IS emitted to `tracing` logs via `Display`.
    /// Callers may include internal detail (paths, env values) — that detail goes to
    /// logs only, never to the frontend.
    #[error("configuration error: {0}")]
    Config(String),

    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("{entity} not found: {id}")]
    NotFound { entity: &'static str, id: String },

    /// Validation errors — the `String` payload IS passed through to the wire.
    /// It MUST be a statically authored, user-facing message (e.g. "name must be
    /// <= 100 chars"), never a raw external value such as a provider response body
    /// or OS error string.
    #[error("validation error: {0}")]
    Validation(String),

    // Dormant variants — defined now so the taxonomy is stable; used by later sub-projects.
    #[allow(dead_code)]
    #[error("provider error: {0}")]
    Provider(String),
    #[allow(dead_code)]
    #[error("network error: {0}")]
    Network(String),
    #[allow(dead_code)]
    #[error("clipboard error: {0}")]
    Clipboard(String),
    #[allow(dead_code)]
    #[error("shortcut error: {0}")]
    Shortcut(String),
    #[allow(dead_code)]
    #[error("permission error: {0}")]
    Permission(String),
}

impl AppError {
    /// Stable machine-readable code for the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Database(_) => "DATABASE_ERROR",
            AppError::Migration(_) => "MIGRATION_ERROR",
            AppError::Config(_) => "CONFIG_ERROR",
            AppError::Io(_) => "IO_ERROR",
            AppError::Serialization(_) => "SERIALIZATION_ERROR",
            AppError::NotFound { .. } => "NOT_FOUND",
            AppError::Validation(_) => "VALIDATION_ERROR",
            AppError::Provider(_) => "PROVIDER_ERROR",
            AppError::Network(_) => "NETWORK_ERROR",
            AppError::Clipboard(_) => "CLIPBOARD_ERROR",
            AppError::Shortcut(_) => "SHORTCUT_ERROR",
            AppError::Permission(_) => "PERMISSION_ERROR",
        }
    }

    /// Whether retrying the operation could plausibly succeed.
    pub fn retriable(&self) -> bool {
        matches!(self, AppError::Network(_) | AppError::Clipboard(_))
    }

    /// Frontend-safe human message. Never includes SQL text, file paths, or
    /// raw driver output — only the error category.
    pub fn safe_message(&self) -> String {
        match self {
            AppError::Database(_) => "A database operation failed.".into(),
            AppError::Migration(_) => "The database could not be initialized.".into(),
            AppError::Config(_) => "The application is misconfigured.".into(),
            AppError::Io(_) => "A file operation failed.".into(),
            AppError::Serialization(_) => "Failed to process data.".into(),
            AppError::NotFound { entity, .. } => format!("The requested {entity} was not found."),
            AppError::Validation(msg) => msg.clone(),
            AppError::Provider(_) => "The AI provider returned an error.".into(),
            AppError::Network(_) => "A network request failed.".into(),
            AppError::Clipboard(_) => "A clipboard operation failed.".into(),
            AppError::Shortcut(_) => "A shortcut operation failed.".into(),
            AppError::Permission(_) => "Permission was denied.".into(),
        }
    }
}

/// Sanitized wire shape. The verbose `Display` impl goes only to `tracing` logs.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.safe_message())?;
        s.serialize_field("retriable", &self.retriable())?;
        s.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_error_serializes_without_leaking_sql() {
        let err = AppError::Database(sqlx::Error::RowNotFound);
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"code\":\"DATABASE_ERROR\""));
        assert!(json.contains("A database operation failed."));
        // The raw driver message must NOT appear on the wire.
        assert!(!json.contains("RowNotFound"));
    }

    #[test]
    fn validation_message_passes_through() {
        let err = AppError::Validation("temperature must be between 0 and 2".into());
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("temperature must be between 0 and 2"));
        assert!(json.contains("\"retriable\":false"));
    }

    #[test]
    fn network_error_is_retriable() {
        let err = AppError::Network("timeout".into());
        assert!(err.retriable());
    }
}
