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

    /// List all prompt modes ordered by `sort_order`.
    pub async fn list(&self) -> AppResult<Vec<PromptMode>> {
        let modes: Vec<PromptMode> = sqlx::query_as(
            "SELECT id, name, description, system_prompt, temperature, max_tokens,
                    provider_override, icon_name
             FROM prompt_modes ORDER BY sort_order ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(modes)
    }

    /// Fetch one prompt mode by id.
    #[allow(dead_code)]
    pub async fn get(&self, id: &str) -> AppResult<PromptMode> {
        let mode: Option<PromptMode> = sqlx::query_as(
            "SELECT id, name, description, system_prompt, temperature, max_tokens,
                    provider_override, icon_name
             FROM prompt_modes WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        mode.ok_or_else(|| AppError::NotFound { entity: "prompt_mode", id: id.to_string() })
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
