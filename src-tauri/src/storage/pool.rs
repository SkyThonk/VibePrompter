//! SQLite connection pool creation and migration running.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::utils::AppResult;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("src/storage/migrations");

/// Create the application connection pool at `db_path`, creating the file if missing.
/// Uses WAL + NORMAL synchronous for concurrency and performance.
pub async fn create_pool(db_path: &Path) -> AppResult<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    Ok(pool)
}

/// Run all embedded migrations. Idempotent — already-applied migrations are skipped.
pub async fn run_migrations(pool: &SqlitePool) -> AppResult<()> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

/// Snapshot the DB file alongside itself (`<db>.bak`) before any migration
/// run that would actually apply something. Cheap insurance — if a future
/// migration corrupts data the user has a one-step rollback.
///
/// Skipped if (a) no DB file exists yet (fresh install), (b) every embedded
/// migration is already applied (nothing to back up), or (c) the previous
/// backup is newer than the current DB (back-up already taken this session).
pub async fn backup_before_migrations(pool: &SqlitePool, db_path: &Path) -> AppResult<()> {
    if !db_path.exists() {
        return Ok(());
    }

    let applied: Vec<(i64,)> = sqlx::query_as("SELECT version FROM _sqlx_migrations")
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let applied_set: std::collections::HashSet<i64> =
        applied.into_iter().map(|(v,)| v).collect();
    let pending = MIGRATOR
        .migrations
        .iter()
        .any(|m| !applied_set.contains(&(m.version)));
    if !pending {
        return Ok(());
    }

    let backup_path = db_path.with_extension("db.bak");
    let db_mtime = std::fs::metadata(db_path)
        .and_then(|m| m.modified())
        .ok();
    let backup_mtime = std::fs::metadata(&backup_path)
        .and_then(|m| m.modified())
        .ok();
    if let (Some(db_t), Some(bak_t)) = (db_mtime, backup_mtime) {
        if bak_t > db_t {
            tracing::debug!("skip db backup — existing one is newer");
            return Ok(());
        }
    }

    match std::fs::copy(db_path, &backup_path) {
        Ok(n) => {
            tracing::info!(
                "db backup written: {} → {} ({} bytes)",
                db_path.display(),
                backup_path.display(),
                n
            );
        }
        Err(e) => {
            // Backup failure should NOT block the migration — the user may
            // be on a read-only volume or low on disk. Loud warn, then
            // proceed. Migrations themselves run in transactions so a
            // failed migration won't half-apply.
            tracing::warn!("db backup failed (proceeding anyway): {e}");
        }
    }
    Ok(())
}

/// Create an in-memory pool with migrations applied — for tests only.
#[cfg(test)]
pub async fn test_pool() -> SqlitePool {
    use std::str::FromStr;
    let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    run_migrations(&pool).await.unwrap();
    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_create_all_tables() {
        let pool = test_pool().await;
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        for expected in [
            "analytics",
            "history",
            "prompt_modes",
            "provider_connections",
            "providers",
            "settings",
            "shortcuts",
        ] {
            assert!(names.contains(&expected), "missing table: {expected}");
        }
    }

    #[tokio::test]
    async fn seed_data_is_present() {
        let pool = test_pool().await;
        let (providers,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM providers").fetch_one(&pool).await.unwrap();
        let (modes,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM prompt_modes").fetch_one(&pool).await.unwrap();
        let (shortcuts,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM shortcuts").fetch_one(&pool).await.unwrap();
        let (settings,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM settings").fetch_one(&pool).await.unwrap();
        assert_eq!(providers, 4);
        assert_eq!(modes, 6);
        assert_eq!(shortcuts, 5);
        // Three keys (auto_paste, clipboard_fallback, low_memory_mode) were
        // dropped in migration 0005 — they no longer back any behavior.
        assert_eq!(settings, 14);
    }

    #[tokio::test]
    async fn migrations_are_idempotent() {
        let pool = test_pool().await;
        // Running again must be a clean no-op.
        run_migrations(&pool).await.unwrap();
    }
}
