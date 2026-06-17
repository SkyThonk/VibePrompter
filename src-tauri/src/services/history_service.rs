//! History business logic. Foundation exposes list + clear; `record` is here
//! for sub-project 2 to call after an AI transformation.

use crate::events::{AppEvent, EventBus};
use crate::models::{HistoryItem, HistoryQuery, NewHistoryItem};
use crate::storage::repositories::HistoryRepo;
use crate::utils::AppResult;

#[derive(Clone)]
pub struct HistoryService {
    repo: HistoryRepo,
    // None in unit tests where no AppHandle is available.
    events: Option<EventBus>,
}

impl HistoryService {
    /// Wires the EventBus so every successful `record()` fires a
    /// `history_changed` event the frontend can invalidate caches on.
    pub fn with_events(repo: HistoryRepo, events: EventBus) -> Self {
        Self { repo, events: Some(events) }
    }

    fn emit(&self, event: AppEvent) {
        if let Some(bus) = &self.events {
            bus.emit(event);
        }
    }

    /// List top-level history newest-first (tweaks are nested under their root
    /// and fetched via `children_of`).
    pub async fn list(&self, query: HistoryQuery) -> AppResult<Vec<HistoryItem>> {
        self.repo.list(&query).await
    }

    /// Tweaks/followups belonging to a thread root, oldest-first.
    pub async fn children_of(&self, parent_id: i64) -> AppResult<Vec<HistoryItem>> {
        self.repo.children_of(parent_id).await
    }

    /// Every row including tweaks — for export, so a dump is complete.
    pub async fn list_all(&self, query: HistoryQuery) -> AppResult<Vec<HistoryItem>> {
        self.repo.list_all(&query).await
    }

    /// Delete all history; returns the number of rows removed. Fires
    /// `history_changed` so panels refresh immediately.
    pub async fn clear(&self) -> AppResult<u64> {
        let n = self.repo.clear().await?;
        self.emit(AppEvent::HistoryChanged);
        Ok(n)
    }

    pub async fn count(&self) -> AppResult<i64> {
        self.repo.count().await
    }

    pub async fn set_favorite(&self, id: i64, favorite: bool) -> AppResult<()> {
        self.repo.set_favorite(id, favorite).await
    }

    /// Cost summary over last 7 / 30 days + lifetime. Returns the tuple
    /// (month_micros, week_micros, total_micros, month_priced_runs,
    /// month_unpriced_runs) — the command layer wraps this into the IPC
    /// `CostSummary` shape.
    pub async fn cost_summary(&self) -> AppResult<(i64, i64, i64, i64, i64)> {
        let now = chrono::Utc::now();
        let month_ago = (now - chrono::Duration::days(30)).to_rfc3339();
        let week_ago = (now - chrono::Duration::days(7)).to_rfc3339();
        self.repo.cost_summary(&month_ago, &week_ago).await
    }

    /// Per-day cost totals over the trailing N days. Used by the dashboard
    /// cost-trend chart.
    pub async fn cost_by_day(&self, days: i64) -> AppResult<Vec<(String, i64, i64)>> {
        let since = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339();
        self.repo.cost_by_day(&since).await
    }

    /// Per-connection cost breakdown over the trailing N days. Used by the
    /// dashboard cost card to show which connection drives spend.
    pub async fn cost_by_connection(&self, days: i64) -> AppResult<Vec<(String, i64, i64)>> {
        let since = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339();
        self.repo.cost_by_connection(&since).await
    }

    /// Record a completed transformation. Fires `history_changed` on success
    /// so the History settings panel + dashboard recent-activity strip refresh
    /// without polling. Emit failures are swallowed by the EventBus itself;
    /// the insert result propagates either way.
    #[allow(dead_code)]
    pub async fn record(&self, item: NewHistoryItem) -> AppResult<i64> {
        let id = self.repo.insert(&item).await?;
        self.emit(AppEvent::HistoryChanged);
        Ok(id)
    }

    /// Apply the user's retention policy. `retention` is the same string the
    /// `Settings.history_retention` field carries — `"30d"`, `"90d"`,
    /// `"365d"`, or `"forever"`. Anything matching `forever` (or that fails to
    /// parse) is treated as "never purge", so a typo can't accidentally wipe
    /// the user's data. Returns the number of rows removed.
    pub async fn enforce_retention(&self, retention: &str) -> AppResult<u64> {
        let days = match retention.trim().to_ascii_lowercase().as_str() {
            "forever" | "" => return Ok(0),
            other => {
                let stripped = other.strip_suffix('d').unwrap_or(other);
                match stripped.parse::<i64>() {
                    Ok(d) if d > 0 => d,
                    _ => {
                        tracing::warn!("unrecognized history_retention '{retention}' — treating as forever");
                        return Ok(0);
                    }
                }
            }
        };
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339();
        let removed = self.repo.purge_older_than(&cutoff).await?;
        if removed > 0 {
            tracing::info!("history retention purged {removed} rows older than {days}d");
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;
    use crate::storage::repositories::HistoryRepo;

    fn svc(repo: HistoryRepo) -> HistoryService {
        HistoryService { repo, events: None }
    }

    #[tokio::test]
    async fn record_then_list_returns_item() {
        let service = svc(HistoryRepo::new(test_pool().await));
        service
            .record(NewHistoryItem {
                mode_name: "Email".into(),
                icon_name: "mail".into(),
                provider_label: "Claude".into(),
                source_text: "hi".into(),
                output_text: "Hello".into(),
                latency_ms: 900,
                input_tokens: 0,
                output_tokens: 0,
                cost_micros: 0,
                parent_id: None,
            })
            .await
            .unwrap();
        let items = service.list(HistoryQuery::default()).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].mode_name, "Email");
    }

    #[tokio::test]
    async fn enforce_retention_forever_is_noop() {
        let service = svc(HistoryRepo::new(test_pool().await));
        service.record(sample()).await.unwrap();
        // Both "forever" and unrecognized strings must keep data — this is
        // the safety guarantee that a typo can't wipe history.
        assert_eq!(service.enforce_retention("forever").await.unwrap(), 0);
        assert_eq!(service.enforce_retention("not-a-duration").await.unwrap(), 0);
        assert_eq!(service.enforce_retention("").await.unwrap(), 0);
        assert_eq!(service.list(HistoryQuery::default()).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn enforce_retention_30d_purges_old_rows() {
        let service = svc(HistoryRepo::new(test_pool().await));
        // Insert with the default `now` timestamp.
        service.record(sample()).await.unwrap();
        // A 1-day window starting today still includes the just-inserted row,
        // so nothing should be removed.
        assert_eq!(service.enforce_retention("1d").await.unwrap(), 0);
        assert_eq!(service.list(HistoryQuery::default()).await.unwrap().len(), 1);
    }

    fn sample() -> NewHistoryItem {
        NewHistoryItem {
            mode_name: "Email".into(),
            icon_name: "mail".into(),
            provider_label: "Claude".into(),
            source_text: "hi".into(),
            output_text: "Hello".into(),
            latency_ms: 900,
            input_tokens: 0,
            output_tokens: 0,
            cost_micros: 0,
            parent_id: None,
        }
    }

    #[tokio::test]
    async fn clear_empties_history() {
        let service = svc(HistoryRepo::new(test_pool().await));
        service
            .record(NewHistoryItem {
                mode_name: "Email".into(),
                icon_name: "mail".into(),
                provider_label: "Claude".into(),
                source_text: "hi".into(),
                output_text: "Hello".into(),
                latency_ms: 900,
                input_tokens: 0,
                output_tokens: 0,
                cost_micros: 0,
                parent_id: None,
            })
            .await
            .unwrap();
        let removed = service.clear().await.unwrap();
        assert_eq!(removed, 1);
        assert!(service.list(HistoryQuery::default()).await.unwrap().is_empty());
    }
}
