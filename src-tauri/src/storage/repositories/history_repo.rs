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

    /// List top-level history newest-first, paginated. Tweaks/followups
    /// (`parent_id IS NOT NULL`) are excluded — they belong to a thread and are
    /// fetched via `children_of` when their root is opened. Pagination therefore
    /// pages over refines, not over every tweak.
    pub async fn list(&self, query: &HistoryQuery) -> AppResult<Vec<HistoryItem>> {
        // Favorites sort to the top of each page first, then by recency.
        // Within favorites or non-favorites, newest-first.
        let items: Vec<HistoryItem> = sqlx::query_as(
            "SELECT id, mode_name, icon_name, provider_label, source_text, output_text,
                    latency_ms, favorite, created_at, input_tokens, output_tokens, cost_micros,
                    parent_id
             FROM history
             WHERE parent_id IS NULL
             ORDER BY favorite DESC, created_at DESC, id DESC
             LIMIT ?1 OFFSET ?2",
        )
        .bind(query.limit)
        .bind(query.offset)
        .fetch_all(&self.pool)
        .await?;
        Ok(items)
    }

    /// List every row including tweaks, newest-first. Used by export so a
    /// JSON dump contains the full history; `parent_id` on each row keeps the
    /// thread structure reconstructable.
    pub async fn list_all(&self, query: &HistoryQuery) -> AppResult<Vec<HistoryItem>> {
        let items: Vec<HistoryItem> = sqlx::query_as(
            "SELECT id, mode_name, icon_name, provider_label, source_text, output_text,
                    latency_ms, favorite, created_at, input_tokens, output_tokens, cost_micros,
                    parent_id
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

    /// Fetch a thread's tweaks/followups oldest-first (chronological order), so
    /// the detail pane can render the conversation original → result → tweak →
    /// result. Returns an empty vec when the entry has no tweaks.
    pub async fn children_of(&self, parent_id: i64) -> AppResult<Vec<HistoryItem>> {
        let items: Vec<HistoryItem> = sqlx::query_as(
            "SELECT id, mode_name, icon_name, provider_label, source_text, output_text,
                    latency_ms, favorite, created_at, input_tokens, output_tokens, cost_micros,
                    parent_id
             FROM history
             WHERE parent_id = ?1
             ORDER BY created_at ASC, id ASC",
        )
        .bind(parent_id)
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
                created_at, input_tokens, output_tokens, cost_micros, parent_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
        .bind(item.cost_micros)
        .bind(item.parent_id)
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

    /// Per-day cost totals over the trailing window. Returns rows of
    /// `(yyyy-mm-dd UTC, micros, run_count)` ordered oldest-first so the
    /// frontend can render a left-to-right bar chart without resorting.
    /// Days with zero activity in the window are NOT in the result — the
    /// frontend is responsible for filling gaps (clearer than dumping a
    /// dense vector of mostly-zero rows across the wire).
    pub async fn cost_by_day(
        &self,
        since_rfc3339: &str,
    ) -> AppResult<Vec<(String, i64, i64)>> {
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT substr(created_at, 1, 10) AS day,
                    COALESCE(SUM(cost_micros), 0) AS micros,
                    COUNT(*) AS runs
             FROM history
             WHERE created_at >= ?1
             GROUP BY day
             ORDER BY day ASC",
        )
        .bind(since_rfc3339)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Per-connection cost totals over the trailing window. The
    /// `provider_label` column in history holds "<connection label> ·
    /// <model id>", so we group on the prefix before " · " to merge
    /// runs across different models on the same connection. Returns
    /// rows of `(connection_label, micros, runs)` ordered by spend desc.
    pub async fn cost_by_connection(
        &self,
        since_rfc3339: &str,
    ) -> AppResult<Vec<(String, i64, i64)>> {
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT
               CASE
                 WHEN instr(provider_label, ' · ') > 0
                   THEN substr(provider_label, 1, instr(provider_label, ' · ') - 1)
                 ELSE provider_label
               END AS label,
               COALESCE(SUM(cost_micros), 0) AS micros,
               COUNT(*) AS runs
             FROM history
             WHERE created_at >= ?1
             GROUP BY label
             ORDER BY micros DESC, runs DESC",
        )
        .bind(since_rfc3339)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Aggregate cost over windows for the dashboard widget. Returns
    /// (month_micros, week_micros, total_micros, month_priced_runs, month_unpriced_runs).
    pub async fn cost_summary(
        &self,
        month_cutoff_rfc3339: &str,
        week_cutoff_rfc3339: &str,
    ) -> AppResult<(i64, i64, i64, i64, i64)> {
        let row: (i64, i64, i64, i64, i64) = sqlx::query_as(
            "SELECT
               COALESCE(SUM(CASE WHEN created_at >= ?1 THEN cost_micros ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN created_at >= ?2 THEN cost_micros ELSE 0 END), 0),
               COALESCE(SUM(cost_micros), 0),
               COALESCE(SUM(CASE WHEN created_at >= ?1 AND cost_micros > 0 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN created_at >= ?1 AND cost_micros = 0 THEN 1 ELSE 0 END), 0)
             FROM history",
        )
        .bind(month_cutoff_rfc3339)
        .bind(week_cutoff_rfc3339)
        .fetch_one(&self.pool)
        .await?;
        Ok(row)
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
            cost_micros: 0,
            parent_id: None,
        }
    }

    fn child_of(parent_id: i64) -> NewHistoryItem {
        NewHistoryItem {
            mode_name: "Developer".into(),
            icon_name: "code".into(),
            provider_label: "GPT-4.1".into(),
            source_text: "make it shorter".into(),
            output_text: "shorter out".into(),
            latency_ms: 800,
            input_tokens: 0,
            output_tokens: 0,
            cost_micros: 0,
            parent_id: Some(parent_id),
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
    async fn list_excludes_tweaks_and_children_of_returns_them() {
        let repo = HistoryRepo::new(test_pool().await);
        let root = repo.insert(&sample()).await.unwrap();
        let c1 = repo.insert(&child_of(root)).await.unwrap();
        let c2 = repo.insert(&child_of(root)).await.unwrap();

        // The top-level list shows only the root, not its tweaks.
        let listed = repo.list(&HistoryQuery::default()).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, root);
        assert_eq!(listed[0].parent_id, None);

        // children_of returns the tweaks oldest-first.
        let children = repo.children_of(root).await.unwrap();
        assert_eq!(children.iter().map(|c| c.id).collect::<Vec<_>>(), vec![c1, c2]);
        assert!(children.iter().all(|c| c.parent_id == Some(root)));
    }

    #[tokio::test]
    async fn deleting_a_root_cascades_to_its_tweaks() {
        let repo = HistoryRepo::new(test_pool().await);
        let root = repo.insert(&sample()).await.unwrap();
        repo.insert(&child_of(root)).await.unwrap();
        // clear() wipes everything, so target the root directly to prove the
        // ON DELETE CASCADE foreign key removes the child too.
        sqlx::query("DELETE FROM history WHERE id = ?1")
            .bind(root)
            .execute(&repo.pool)
            .await
            .unwrap();
        assert_eq!(repo.count().await.unwrap(), 0);
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
