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
        assert_eq!(settings, 17);
    }

    #[tokio::test]
    async fn migrations_are_idempotent() {
        let pool = test_pool().await;
        // Running again must be a clean no-op.
        run_migrations(&pool).await.unwrap();
    }
}
