//! Analytics events — append-only audit trail. Everything here is local;
//! nothing is shipped off-device. Used for support diagnostics ("what did
//! the app actually do?") and future per-user usage views.

use sqlx::SqlitePool;

use crate::utils::AppResult;

#[derive(Clone)]
pub struct AnalyticsRepo {
    pool: SqlitePool,
}

impl AnalyticsRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Append one event. `payload_json` must already be valid JSON — callers
    /// build it via `serde_json::json!{...}.to_string()`.
    pub async fn record(&self, event_type: &str, payload_json: &str) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO analytics (event_type, payload, created_at) VALUES (?1, ?2, ?3)",
        )
        .bind(event_type)
        .bind(payload_json)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Most recent `limit` events, newest-first. Used by the About panel's
    /// future "recent activity" view and ad-hoc debugging.
    #[allow(dead_code)]
    pub async fn recent(&self, limit: i64) -> AppResult<Vec<(String, String, String)>> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT event_type, payload, created_at
             FROM analytics ORDER BY id DESC LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Aggregate metrics for the About panel's at-a-glance usage card. All
    /// derived from the events written by `AnalyticsService::record` —
    /// nothing leaves the device.
    pub async fn summary(&self) -> AppResult<AnalyticsSummary> {
        // 24-hour windows. SQLite's datetime() accepts "now" and modifiers.
        let cutoff_24h = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();

        let (runs_24h,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM analytics
             WHERE event_type = 'prompt_run' AND created_at >= ?1",
        )
        .bind(&cutoff_24h)
        .fetch_one(&self.pool)
        .await?;

        let (runs_total,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM analytics WHERE event_type = 'prompt_run'")
                .fetch_one(&self.pool)
                .await
                .unwrap_or((0,));

        let (tests_24h,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM analytics
             WHERE event_type = 'connection_test' AND created_at >= ?1",
        )
        .bind(&cutoff_24h)
        .fetch_one(&self.pool)
        .await
        .unwrap_or((0,));

        let (tests_failed_24h,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM analytics
             WHERE event_type = 'connection_test'
               AND created_at >= ?1
               AND json_extract(payload, '$.ok') = 0",
        )
        .bind(&cutoff_24h)
        .fetch_one(&self.pool)
        .await
        .unwrap_or((0,));

        let last_event: Option<(String, String)> = sqlx::query_as(
            "SELECT event_type, created_at FROM analytics ORDER BY id DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .unwrap_or(None);

        Ok(AnalyticsSummary {
            runs_24h,
            runs_total,
            tests_24h,
            tests_failed_24h,
            last_event_type: last_event.as_ref().map(|(t, _)| t.clone()),
            last_event_at: last_event.map(|(_, t)| t),
        })
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSummary {
    pub runs_24h: i64,
    pub runs_total: i64,
    pub tests_24h: i64,
    pub tests_failed_24h: i64,
    pub last_event_type: Option<String>,
    pub last_event_at: Option<String>,
}
