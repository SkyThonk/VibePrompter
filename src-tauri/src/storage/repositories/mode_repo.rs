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
                    provider_override, icon_name, variables,
                    CAST(enabled AS INTEGER) AS enabled,
                    CAST(is_system AS INTEGER) AS is_system
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
                    provider_override, icon_name, variables,
                    CAST(enabled AS INTEGER) AS enabled,
                    CAST(is_system AS INTEGER) AS is_system
             FROM prompt_modes WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        mode.ok_or_else(|| AppError::NotFound { entity: "prompt_mode", id: id.to_string() })
    }

    pub async fn upsert(&self, mode: &PromptMode, sort_order: i64) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        // System modes are locked: callers can change the prompt + sampling +
        // pinned provider + enabled, but the name, description, and icon are
        // preserved from the stored row along with the is_system flag. We
        // detect the existing row by id so a brand-new user mode is unaffected.
        let existing: Option<(String, String, String, i64)> = sqlx::query_as(
            "SELECT name, description, icon_name, CAST(is_system AS INTEGER)
             FROM prompt_modes WHERE id = ?1",
        )
        .bind(&mode.id)
        .fetch_optional(&self.pool)
        .await?;
        let (name, description, icon_name) = match &existing {
            Some((n, d, i, is_sys)) if *is_sys != 0 => {
                (n.clone(), d.clone(), i.clone())
            }
            _ => (
                mode.name.clone(),
                mode.description.clone(),
                mode.icon_name.clone(),
            ),
        };
        // `sort_order` is set only on INSERT; the UPDATE branch leaves it
        // alone so re-saving a mode doesn't reset the user's chosen position.
        // Reordering goes through `swap_sort_order` instead.
        sqlx::query(
            "INSERT INTO prompt_modes
               (id, name, description, system_prompt, temperature, max_tokens,
                provider_override, icon_name, variables, is_default, sort_order,
                enabled, is_system, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, 0, ?12, ?12)
             ON CONFLICT(id) DO UPDATE SET
               name = ?2, description = ?3, system_prompt = ?4,
               temperature = ?5, max_tokens = ?6, provider_override = ?7,
               icon_name = ?8, variables = ?9, enabled = ?11,
               updated_at = ?12",
        )
        .bind(&mode.id)
        .bind(&name)
        .bind(&description)
        .bind(&mode.system_prompt)
        .bind(mode.temperature)
        .bind(mode.max_tokens)
        .bind(&mode.provider_override)
        .bind(&icon_name)
        .bind(&mode.variables)
        .bind(sort_order)
        .bind(mode.enabled as i64)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        // Refuse to delete built-in modes; the UI hides the delete affordance,
        // but a direct command invocation would otherwise succeed and the
        // mode would be gone until reinstall (the seed uses INSERT OR IGNORE).
        let is_system: Option<(i64,)> =
            sqlx::query_as("SELECT CAST(is_system AS INTEGER) FROM prompt_modes WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        if matches!(is_system, Some((n,)) if n != 0) {
            return Err(AppError::Validation(format!(
                "Cannot delete built-in mode '{id}'. Disable it instead."
            )));
        }
        sqlx::query("DELETE FROM prompt_modes WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Atomically swap the `sort_order` of two modes. Used by the reorder
    /// controls in the Modes settings panel. Both modes must exist; if one
    /// doesn't, the swap is a no-op and the caller's reorder request is
    /// silently dropped (the UI should never offer to swap with a missing
    /// neighbor — the affordance is hidden at list boundaries).
    pub async fn swap_sort_order(&self, id_a: &str, id_b: &str) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        let a: Option<(i64,)> =
            sqlx::query_as("SELECT sort_order FROM prompt_modes WHERE id = ?1")
                .bind(id_a)
                .fetch_optional(&mut *tx)
                .await?;
        let b: Option<(i64,)> =
            sqlx::query_as("SELECT sort_order FROM prompt_modes WHERE id = ?1")
                .bind(id_b)
                .fetch_optional(&mut *tx)
                .await?;
        let (Some((sa,)), Some((sb,))) = (a, b) else {
            tx.rollback().await.ok();
            return Ok(());
        };
        if sa == sb {
            tx.rollback().await.ok();
            return Ok(());
        }
        sqlx::query("UPDATE prompt_modes SET sort_order = ?1 WHERE id = ?2")
            .bind(sb)
            .bind(id_a)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE prompt_modes SET sort_order = ?1 WHERE id = ?2")
            .bind(sa)
            .bind(id_b)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
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
    async fn list_returns_seeded_modes_with_system_first() {
        let repo = ModeRepo::new(test_pool().await);
        let modes = repo.list().await.unwrap();
        // 6 original user-editable seeds + 2 system modes (grammar, summarize).
        assert_eq!(modes.len(), 8);
        // Built-ins use negative sort_order so they sit at the top.
        assert_eq!(modes[0].id, "grammar");
        assert!(modes[0].is_system);
        assert_eq!(modes[1].id, "summarize");
        assert!(modes[1].is_system);
        assert!(!modes[2].is_system);
    }

    #[tokio::test]
    async fn delete_system_mode_is_rejected() {
        let repo = ModeRepo::new(test_pool().await);
        let err = repo.delete("grammar").await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn get_missing_returns_not_found() {
        let repo = ModeRepo::new(test_pool().await);
        let err = repo.get("nope").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound { entity: "prompt_mode", .. }));
    }
}
