//! Prompt mode persistence — read-only in the Foundation sub-project. Write
//! paths are added by sub-project 2.

use sqlx::SqlitePool;

use crate::models::PromptMode;
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct ModeRepo {
    pool: SqlitePool,
}

impl ModeRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// List all prompt modes ordered by `sort_order`. Includes disabled modes —
    /// callers that drive tray / cycle / dashboard surfaces must filter by
    /// `mode.enabled` themselves so the Modes settings panel can still see
    /// every record for management.
    pub async fn list(&self) -> AppResult<Vec<PromptMode>> {
        let modes: Vec<PromptMode> = sqlx::query_as(
            "SELECT id, name, description, system_prompt, temperature, max_tokens,
                    provider_override, icon_name, tags,
                    CAST(enabled AS INTEGER) AS enabled
             FROM prompt_modes ORDER BY sort_order ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(modes)
    }

    /// Fetch one prompt mode by id.
    pub async fn get(&self, id: &str) -> AppResult<PromptMode> {
        let mode: Option<PromptMode> = sqlx::query_as(
            "SELECT id, name, description, system_prompt, temperature, max_tokens,
                    provider_override, icon_name, tags,
                    CAST(enabled AS INTEGER) AS enabled
             FROM prompt_modes WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        mode.ok_or_else(|| AppError::NotFound { entity: "prompt_mode", id: id.to_string() })
    }

    pub async fn upsert(&self, mode: &PromptMode, sort_order: i64) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO prompt_modes
               (id, name, description, system_prompt, temperature, max_tokens,
                provider_override, icon_name, tags, is_default, sort_order,
                enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?12)
             ON CONFLICT(id) DO UPDATE SET
               name = ?2, description = ?3, system_prompt = ?4,
               temperature = ?5, max_tokens = ?6, provider_override = ?7,
               icon_name = ?8, tags = ?9, sort_order = ?10, enabled = ?11,
               updated_at = ?12",
        )
        .bind(&mode.id)
        .bind(&mode.name)
        .bind(&mode.description)
        .bind(&mode.system_prompt)
        .bind(mode.temperature)
        .bind(mode.max_tokens)
        .bind(&mode.provider_override)
        .bind(&mode.icon_name)
        .bind(&mode.tags)
        .bind(sort_order)
        .bind(mode.enabled as i64)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM prompt_modes WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Highest current sort_order. Used when inserting a new mode so it lands
    /// at the bottom of the list by default.
    pub async fn max_sort_order(&self) -> AppResult<i64> {
        let row: (Option<i64>,) =
            sqlx::query_as("SELECT MAX(sort_order) FROM prompt_modes")
                .fetch_one(&self.pool)
                .await?;
        Ok(row.0.unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;

    #[tokio::test]
    async fn list_returns_six_seeded_modes_in_order() {
        let repo = ModeRepo::new(test_pool().await);
        let modes = repo.list().await.unwrap();
        assert_eq!(modes.len(), 6);
        assert_eq!(modes[0].id, "developer");
    }

    #[tokio::test]
    async fn get_missing_returns_not_found() {
        let repo = ModeRepo::new(test_pool().await);
        let err = repo.get("nope").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound { entity: "prompt_mode", .. }));
    }
}
