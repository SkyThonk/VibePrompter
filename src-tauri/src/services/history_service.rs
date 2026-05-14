//! History business logic. Foundation exposes list + clear; `record` is here
//! for sub-project 2 to call after an AI transformation.

use crate::models::{HistoryItem, HistoryQuery, NewHistoryItem};
use crate::storage::repositories::HistoryRepo;
use crate::utils::AppResult;

#[derive(Clone)]
pub struct HistoryService {
    repo: HistoryRepo,
}

impl HistoryService {
    pub fn new(repo: HistoryRepo) -> Self {
        Self { repo }
    }

    /// List history newest-first.
    pub async fn list(&self, query: HistoryQuery) -> AppResult<Vec<HistoryItem>> {
        self.repo.list(&query).await
    }

    /// Delete all history; returns the number of rows removed.
    pub async fn clear(&self) -> AppResult<u64> {
        self.repo.clear().await
    }

    /// Record a completed transformation. Used by sub-project 2.
    #[allow(dead_code)]
    pub async fn record(&self, item: NewHistoryItem) -> AppResult<i64> {
        self.repo.insert(&item).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;
    use crate::storage::repositories::HistoryRepo;

    fn svc(repo: HistoryRepo) -> HistoryService {
        HistoryService::new(repo)
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
            })
            .await
            .unwrap();
        let items = service.list(HistoryQuery::default()).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].mode_name, "Email");
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
            })
            .await
            .unwrap();
        let removed = service.clear().await.unwrap();
        assert_eq!(removed, 1);
        assert!(service.list(HistoryQuery::default()).await.unwrap().is_empty());
    }
}
