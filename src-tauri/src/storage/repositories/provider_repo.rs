//! Provider config persistence — read-only in the Foundation sub-project.
//! Builds `ProviderInfo` DTOs, extracting `accent`/`local` from the `extra` JSON.

use sqlx::SqlitePool;

use crate::models::ProviderInfo;
use crate::utils::AppResult;

#[derive(Clone)]
pub struct ProviderRepo {
    pool: SqlitePool,
}

/// Internal row shape before `extra` is unpacked.
#[derive(sqlx::FromRow)]
struct ProviderRow {
    id: String,
    display_name: String,
    enabled: bool,
    default_model: String,
    extra: String,
}

impl ProviderRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// List all providers as frontend-shaped `ProviderInfo` DTOs.
    pub async fn list(&self) -> AppResult<Vec<ProviderInfo>> {
        let rows: Vec<ProviderRow> = sqlx::query_as(
            "SELECT id, display_name, enabled, default_model, extra
             FROM providers ORDER BY id ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let row_id = row.id.clone();
            let extra: serde_json::Value = serde_json::from_str(&row.extra)
                .unwrap_or_else(|e| {
                    tracing::warn!("provider `{}` has malformed extra JSON: {e}", row_id);
                    serde_json::Value::Null
                });
            out.push(ProviderInfo {
                id: row.id,
                name: row.display_name,
                accent: extra.get("accent").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                status: if row.enabled { "ok".into() } else { "idle".into() },
                model: row.default_model,
                usage: 0,
                local: extra.get("local").and_then(|v| v.as_bool()).unwrap_or(false),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;

    #[tokio::test]
    async fn list_returns_four_seeded_providers() {
        let repo = ProviderRepo::new(test_pool().await);
        let providers = repo.list().await.unwrap();
        assert_eq!(providers.len(), 4);
        let ollama = providers.iter().find(|p| p.id == "ollama").unwrap();
        assert!(ollama.local);
        assert_eq!(ollama.status, "ok");
        let openai = providers.iter().find(|p| p.id == "openai").unwrap();
        assert!(!openai.local);
    }
}
