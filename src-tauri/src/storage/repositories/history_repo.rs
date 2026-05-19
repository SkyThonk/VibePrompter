//! History persistence — the `history` table.

use sqlx::SqlitePool;

use crate::models::{HistoryItem, HistoryQuery, NewHistoryItem};
use crate::utils::AppResult;

#[derive(Clone)]
pub struct HistoryRepo {
    pool: SqlitePool,
}

impl HistoryRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// List history newest-first, paginated.
    pub async fn list(&self, query: &HistoryQuery) -> AppResult<Vec<HistoryItem>> {
        // Favorites sort to the top of each page first, then by recency.
        // Within favorites or non-favorites, newest-first.
        let items: Vec<HistoryItem> = sqlx::query_as(
            "SELECT id, mode_name, icon_name, provider_label, source_text, output_text,
                    latency_ms, favorite, created_at, input_tokens, output_tokens
             FROM history
             ORDER BY favorite DESC, created_at DESC, id DESC
             LIMIT ?1 OFFSET ?2",
        )
        .bind(query.limit)
        .bind(query.offset)
        .fetch_all(&self.pool)
        .await?;
        Ok(items)
    }

    /// Insert a new history record; returns its row id.
    #[allow(dead_code)]
    pub async fn insert(&self, item: &NewHistoryItem) -> AppResult<i64> {
        let now = chrono::Utc::now().to_rfc3339();
        let id = sqlx::query(
            "INSERT INTO history
               (mode_name, icon_name, provider_label, source_text, output_text, latency_ms,
                created_at, input_tokens, output_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(&item.mode_name)
        .bind(&item.icon_name)
        .bind(&item.provider_label)
        .bind(&item.source_text)
        .bind(&item.output_text)
        .bind(item.latency_ms)
        .bind(now)
        .bind(item.input_tokens)
        .bind(item.output_tokens)
        .execute(&self.pool)
        .await?
        .last_insert_rowid();
        Ok(id)
    }

    pub async fn count(&self) -> AppResult<i64> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM history")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0)
    }

    pub async fn set_favorite(&self, id: i64, favorite: bool) -> AppResult<()> {
        sqlx::query("UPDATE history SET favorite = ?1 WHERE id = ?2")
            .bind(favorite)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete all history rows.
    pub async fn clear(&self) -> AppResult<u64> {
        let affected = sqlx::query("DELETE FROM history")
            .execute(&self.pool)
            .await?
            .rows_affected();
        Ok(affected)
    }

    /// Delete history rows older than the given RFC3339 timestamp.
    pub async fn purge_older_than(&self, cutoff_rfc3339: &str) -> AppResult<u64> {
        let affected = sqlx::query("DELETE FROM history WHERE created_at < ?1")
            .bind(cutoff_rfc3339)
            .execute(&self.pool)
            .await?
            .rows_affected();
        Ok(affected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;

    fn sample() -> NewHistoryItem {
        NewHistoryItem {
            mode_name: "Developer".into(),
            icon_name: "code".into(),
            provider_label: "GPT-4.1".into(),
            source_text: "in".into(),
            output_text: "out".into(),
            latency_ms: 1200,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    #[tokio::test]
    async fn insert_then_list_returns_the_row() {
        let repo = HistoryRepo::new(test_pool().await);
        let id = repo.insert(&sample()).await.unwrap();
        assert!(id > 0);
        let items = repo.list(&HistoryQuery::default()).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].mode_name, "Developer");
        assert!(!items[0].favorite);
    }

    #[tokio::test]
    async fn clear_removes_all_rows() {
        let repo = HistoryRepo::new(test_pool().await);
        repo.insert(&sample()).await.unwrap();
        repo.insert(&sample()).await.unwrap();
        let removed = repo.clear().await.unwrap();
        assert_eq!(removed, 2);
        assert!(repo.list(&HistoryQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_respects_limit() {
        let repo = HistoryRepo::new(test_pool().await);
        for _ in 0..5 {
            repo.insert(&sample()).await.unwrap();
        }
        let q = HistoryQuery { limit: 2, offset: 0 };
        assert_eq!(repo.list(&q).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn purge_older_than_removes_old_rows() {
        let repo = HistoryRepo::new(test_pool().await);
        repo.insert(&sample()).await.unwrap();
        // A timestamp in the far future — everything is "older than" this.
        let removed = repo.purge_older_than("2099-01-01T00:00:00Z").await.unwrap();
        assert_eq!(removed, 1);
        assert!(repo.list(&HistoryQuery::default()).await.unwrap().is_empty());
    }
}
