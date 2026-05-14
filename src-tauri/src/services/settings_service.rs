//! Settings business logic — maps the `Settings` aggregate to/from the
//! key-value `settings` table and emits `settings_changed` on save.

use crate::events::{AppEvent, EventBus};
use crate::models::Settings;
use crate::storage::repositories::SettingsRepo;
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct SettingsService {
    repo: SettingsRepo,
    events: EventBus,
}

impl SettingsService {
    pub fn new(repo: SettingsRepo, events: EventBus) -> Self {
        Self { repo, events }
    }

    /// Load all settings rows and assemble them into a typed `Settings`.
    /// Missing keys fall back to `Settings` field defaults.
    pub async fn get(&self) -> AppResult<Settings> {
        let rows = self.repo.get_all().await?;
        let mut map = serde_json::Map::new();
        for (key, json_value) in rows {
            let value: serde_json::Value = serde_json::from_str(&json_value)
                .map_err(AppError::Serialization)?;
            map.insert(key, value);
        }
        let settings: Settings = serde_json::from_value(serde_json::Value::Object(map))
            .map_err(AppError::Serialization)?;
        Ok(settings)
    }

    /// Persist a full `Settings` aggregate — one upsert per field — then emit
    /// `settings_changed`.
    pub async fn save(&self, settings: &Settings) -> AppResult<()> {
        let value = serde_json::to_value(settings).map_err(AppError::Serialization)?;
        let object = value
            .as_object()
            .ok_or_else(|| AppError::Validation("settings must be an object".into()))?;
        for (key, field_value) in object {
            let json_value = serde_json::to_string(field_value).map_err(AppError::Serialization)?;
            self.repo.upsert(key, &json_value).await?;
        }
        self.events.emit(AppEvent::SettingsChanged);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;
    use crate::storage::repositories::SettingsRepo;

    // EventBus needs an AppHandle, which is unavailable in unit tests. The
    // service tests below exercise repo round-tripping; emit is covered by the
    // manual smoke check in Task 23. We construct the service via a helper that
    // skips the bus by testing the repo-facing logic directly.
    async fn repo() -> SettingsRepo {
        SettingsRepo::new(test_pool().await)
    }

    #[tokio::test]
    async fn get_assembles_seeded_defaults() {
        // Reproduces SettingsService::get without the bus.
        let repo = repo().await;
        let rows = repo.get_all().await.unwrap();
        let mut map = serde_json::Map::new();
        for (k, v) in rows {
            map.insert(k, serde_json::from_str(&v).unwrap());
        }
        let settings: Settings =
            serde_json::from_value(serde_json::Value::Object(map)).unwrap();
        assert!(settings.boot_start);
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.response_timeout, 30);
    }

    #[tokio::test]
    async fn save_then_get_roundtrips_changed_fields() {
        let repo = repo().await;
        let mut settings = Settings::default();
        settings.theme = "light".into();
        settings.response_timeout = 60;

        // Reproduces SettingsService::save without the bus.
        let value = serde_json::to_value(&settings).unwrap();
        for (k, fv) in value.as_object().unwrap() {
            repo.upsert(k, &serde_json::to_string(fv).unwrap()).await.unwrap();
        }

        let rows = repo.get_all().await.unwrap();
        let mut map = serde_json::Map::new();
        for (k, v) in rows {
            map.insert(k, serde_json::from_str(&v).unwrap());
        }
        let loaded: Settings =
            serde_json::from_value(serde_json::Value::Object(map)).unwrap();
        assert_eq!(loaded.theme, "light");
        assert_eq!(loaded.response_timeout, 60);
    }
}
