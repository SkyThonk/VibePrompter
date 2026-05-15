//! Persistence for user-owned provider connections.
//!
//! Keys are stored in plaintext — same security model as Cursor, Raycast, and
//! every other local AI desktop app. A future iteration could move them to
//! the OS keyring (Windows Credential Manager) without changing this layer's
//! shape.

use sqlx::SqlitePool;

use crate::utils::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct ConnectionRow {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
    pub is_default: bool,
}

#[derive(Clone)]
pub struct ConnectionRepo {
    pool: SqlitePool,
}

impl ConnectionRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> AppResult<Vec<ConnectionRow>> {
        let rows: Vec<(String, String, String, String, String, String, bool)> =
            sqlx::query_as(
                "SELECT id, label, kind, base_url, api_key, default_model, is_default
                 FROM provider_connections ORDER BY is_default DESC, created_at ASC",
            )
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|(id, label, kind, base_url, api_key, default_model, is_default)| ConnectionRow {
                id,
                label,
                kind,
                base_url,
                api_key,
                default_model,
                is_default,
            })
            .collect())
    }

    pub async fn get(&self, id: &str) -> AppResult<ConnectionRow> {
        let row: Option<(String, String, String, String, String, String, bool)> =
            sqlx::query_as(
                "SELECT id, label, kind, base_url, api_key, default_model, is_default
                 FROM provider_connections WHERE id = ?1",
            )
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|(id, label, kind, base_url, api_key, default_model, is_default)| ConnectionRow {
            id,
            label,
            kind,
            base_url,
            api_key,
            default_model,
            is_default,
        })
        .ok_or_else(|| AppError::NotFound { entity: "provider_connection", id: id.to_string() })
    }

    pub async fn upsert(&self, row: &ConnectionRow) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO provider_connections
               (id, label, kind, base_url, api_key, default_model, is_default, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(id) DO UPDATE SET
               label = ?2, kind = ?3, base_url = ?4, api_key = ?5,
               default_model = ?6, is_default = ?7, updated_at = ?8",
        )
        .bind(&row.id)
        .bind(&row.label)
        .bind(&row.kind)
        .bind(&row.base_url)
        .bind(&row.api_key)
        .bind(&row.default_model)
        .bind(row.is_default)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM provider_connections WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Atomically clear `is_default` on every row except `winner_id`. Called
    /// after an upsert that sets `is_default = true` so we maintain the
    /// single-default invariant.
    pub async fn clear_other_defaults(&self, winner_id: &str) -> AppResult<()> {
        sqlx::query("UPDATE provider_connections SET is_default = 0 WHERE id != ?1")
            .bind(winner_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_default(&self) -> AppResult<Option<ConnectionRow>> {
        let row: Option<(String, String, String, String, String, String, bool)> =
            sqlx::query_as(
                "SELECT id, label, kind, base_url, api_key, default_model, is_default
                 FROM provider_connections WHERE is_default = 1 LIMIT 1",
            )
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|(id, label, kind, base_url, api_key, default_model, is_default)| {
            ConnectionRow {
                id,
                label,
                kind,
                base_url,
                api_key,
                default_model,
                is_default,
            }
        }))
    }
}
