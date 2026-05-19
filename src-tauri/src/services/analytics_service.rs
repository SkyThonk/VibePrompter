//! Cheap, fire-and-forget analytics recorder. Failures here are logged
//! and swallowed — analytics MUST never block or fail a user operation.

use serde_json::Value;

use crate::storage::repositories::analytics_repo::AnalyticsSummary;
use crate::storage::repositories::AnalyticsRepo;
use crate::utils::AppResult;

#[derive(Clone)]
pub struct AnalyticsService {
    repo: AnalyticsRepo,
}

impl AnalyticsService {
    pub fn new(repo: AnalyticsRepo) -> Self {
        Self { repo }
    }

    pub async fn summary(&self) -> AppResult<AnalyticsSummary> {
        self.repo.summary().await
    }

    /// Record an event with a typed payload. Spawned on the runtime so the
    /// caller never waits for the write.
    pub fn record(&self, event_type: &'static str, payload: Value) {
        let repo = self.repo.clone();
        let json = payload.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = repo.record(event_type, &json).await {
                tracing::warn!("analytics insert failed ({event_type}): {e}");
            }
        });
    }
}
