//! Shortcut config persistence — the `shortcuts` table.

use sqlx::SqlitePool;

use crate::models::{ShortcutConfig, ShortcutItem};
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct ShortcutRepo {
    pool: SqlitePool,
}

impl ShortcutRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// List all shortcuts ordered by `sort_order`. Each item has `keys` derived.
    pub async fn list(&self) -> AppResult<Vec<ShortcutItem>> {
        let items: Vec<ShortcutItem> = sqlx::query_as(
            "SELECT id, label, hint, icon_name, accelerator, action, enabled
             FROM shortcuts ORDER BY sort_order ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(items.into_iter().map(ShortcutItem::with_keys).collect())
    }

    /// Fetch one shortcut by id.
    #[allow(dead_code)]
    pub async fn get(&self, id: &str) -> AppResult<ShortcutItem> {
        let item: Option<ShortcutItem> = sqlx::query_as(
            "SELECT id, label, hint, icon_name, accelerator, action, enabled
             FROM shortcuts WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        item.map(ShortcutItem::with_keys)
            .ok_or_else(|| AppError::NotFound { entity: "shortcut", id: id.to_string() })
    }

    /// Insert or update a shortcut.
    pub async fn upsert(&self, cfg: &ShortcutConfig) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO shortcuts
               (id, label, hint, icon_name, accelerator, action, enabled, sort_order, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               label=?2, hint=?3, icon_name=?4, accelerator=?5, action=?6,
               enabled=?7, sort_order=?8, updated_at=?9",
        )
        .bind(&cfg.id)
        .bind(&cfg.label)
        .bind(&cfg.hint)
        .bind(&cfg.icon_name)
        .bind(&cfg.accelerator)
        .bind(&cfg.action)
        .bind(cfg.enabled)
        .bind(cfg.sort_order)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete a shortcut by id. Errors with `NotFound` if no row was removed.
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let affected = sqlx::query("DELETE FROM shortcuts WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if affected == 0 {
            return Err(AppError::NotFound { entity: "shortcut", id: id.to_string() });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;

    fn cfg(id: &str) -> ShortcutConfig {
        ShortcutConfig {
            id: id.into(),
            label: "Test".into(),
            hint: "hint".into(),
            icon_name: "wand".into(),
            accelerator: "Ctrl+Alt+T".into(),
            action: "test_action".into(),
            enabled: true,
            sort_order: 99,
        }
    }

    #[tokio::test]
    async fn list_returns_seeded_shortcuts_with_keys() {
        let repo = ShortcutRepo::new(test_pool().await);
        let items = repo.list().await.unwrap();
        assert_eq!(items.len(), 5);
        let palette = items.iter().find(|s| s.id == "palette").unwrap();
        assert_eq!(palette.keys, vec!["Ctrl", "Shift", "Space"]);
    }

    #[tokio::test]
    async fn upsert_then_get_roundtrips() {
        let repo = ShortcutRepo::new(test_pool().await);
        repo.upsert(&cfg("custom")).await.unwrap();
        let got = repo.get("custom").await.unwrap();
        assert_eq!(got.accelerator, "Ctrl+Alt+T");
        assert_eq!(got.keys, vec!["Ctrl", "Alt", "T"]);
    }

    #[tokio::test]
    async fn delete_missing_returns_not_found() {
        let repo = ShortcutRepo::new(test_pool().await);
        let err = repo.delete("does-not-exist").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound { entity: "shortcut", .. }));
    }
}
