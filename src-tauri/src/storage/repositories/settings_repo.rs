//! Settings persistence — the key-value `settings` table. Each row is one
//! JSON-encoded scalar.

use sqlx::SqlitePool;

use crate::utils::AppResult;

#[derive(Clone)]
pub struct SettingsRepo {
    pool: SqlitePool,
}

impl SettingsRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// All settings rows as `(key, json_value)` pairs.
    pub async fn get_all(&self) -> AppResult<Vec<(String, String)>> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT key, value FROM settings")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows)
    }

    /// Upsert one key with its JSON-encoded value.
    pub async fn upsert(&self, key: &str, json_value: &str) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
        )
        .bind(key)
        .bind(json_value)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;

    #[tokio::test]
    async fn get_all_returns_seeded_rows() {
        let repo = SettingsRepo::new(test_pool().await);
        let rows = repo.get_all().await.unwrap();
        assert_eq!(rows.len(), 17);
        assert!(rows.iter().any(|(k, v)| k == "theme" && v == "\"dark\""));
    }

    #[tokio::test]
    async fn upsert_inserts_then_updates() {
        let repo = SettingsRepo::new(test_pool().await);
        repo.upsert("theme", "\"light\"").await.unwrap();
        let rows = repo.get_all().await.unwrap();
        let theme = rows.iter().find(|(k, _)| k == "theme").unwrap();
        assert_eq!(theme.1, "\"light\"");
        // Still 17 rows — upsert, not insert.
        assert_eq!(rows.len(), 17);
    }
}
