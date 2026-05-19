//! Diagnostics for the About panel — non-sensitive runtime info plus a
//! tail of the rolling log file for quick triage.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::app::AppState;
use crate::utils::AppError;

#[derive(Debug, Serialize)]
pub struct AppDiagnostics {
    pub version: &'static str,
    pub build_target: &'static str,
    /// Where the SQLite database lives.
    #[serde(rename = "dataDir")]
    pub data_dir: PathBuf,
    /// Where the rolling daily log files are written.
    #[serde(rename = "logDir")]
    pub log_dir: PathBuf,
    /// Which secret backend is active right now.
    #[serde(rename = "secretBackend")]
    pub secret_backend: &'static str,
}

#[tauri::command]
pub async fn get_diagnostics(
    state: State<'_, AppState>,
) -> Result<AppDiagnostics, AppError> {
    Ok(AppDiagnostics {
        version: env!("CARGO_PKG_VERSION"),
        build_target: std::env::consts::OS,
        data_dir: state.config.app_data_dir.clone(),
        log_dir: state.config.log_dir.clone(),
        // Probe the keyring fresh on every call — backend may recover
        // between launches (e.g. Linux D-Bus session came back).
        secret_backend: if crate::security::KeyringStore::new().is_available() {
            "OS keyring"
        } else {
            "volatile in-memory (keyring unavailable)"
        },
    })
}

#[tauri::command]
pub async fn get_analytics_summary(
    state: State<'_, AppState>,
) -> Result<crate::storage::repositories::analytics_repo::AnalyticsSummary, AppError> {
    state.analytics.summary().await
}

/// Reveal one of our known app folders in the OS file explorer. The frontend
/// picks which by name so the underlying paths stay backend-owned (no risk
/// of the UI poking around the filesystem).
#[tauri::command]
pub async fn open_app_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    which: String,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let path = match which.as_str() {
        "data" => state.config.app_data_dir.clone(),
        "log" => state.config.log_dir.clone(),
        other => {
            return Err(AppError::Validation(format!(
                "unknown folder '{other}' (expected 'data' or 'log')"
            )))
        }
    };
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Config(format!("opener: {e}")))
}

#[derive(Debug, Serialize)]
pub struct HealthIssue {
    pub severity: &'static str, // "warn" | "error"
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct HealthReport {
    pub ok: bool,
    pub issues: Vec<HealthIssue>,
}

/// Surface structural problems the dashboard should warn about. Used as the
/// "is anything broken right now?" check on every dashboard load. Cheap —
/// hits SQLite + filesystem only, no network. Vendor reachability is tested
/// per-connection on demand via `test_connection`.
#[tauri::command]
pub async fn run_health_check(state: State<'_, AppState>) -> Result<HealthReport, AppError> {
    let mut issues: Vec<HealthIssue> = Vec::new();

    // 1) Log directory writable?
    if !state.config.log_dir.exists() {
        issues.push(HealthIssue {
            severity: "warn",
            code: "log_dir_missing",
            message: format!("Log directory does not exist: {}", state.config.log_dir.display()),
        });
    }

    // 2) Keyring backend available? (Critical for any saved key.)
    if !crate::security::KeyringStore::new().is_available() {
        issues.push(HealthIssue {
            severity: "warn",
            code: "keyring_unavailable",
            message:
                "OS keyring unavailable — saved API keys won't persist across restarts."
                    .into(),
        });
    }

    // 3) At least one connection configured?
    let connections = state.connections.list().await?;
    if connections.is_empty() {
        issues.push(HealthIssue {
            severity: "error",
            code: "no_connections",
            message: "No provider connections configured. Add one in Settings → Providers."
                .into(),
        });
    } else {
        // 4) Default connection has a key?
        let has_default = connections.iter().any(|c| c.is_default);
        if !has_default {
            issues.push(HealthIssue {
                severity: "warn",
                code: "no_default_connection",
                message:
                    "No default connection — set one so prompts know which provider to use."
                        .into(),
            });
        }
        let default_missing_key = connections.iter().any(|c| c.is_default && !c.has_key);
        if default_missing_key {
            issues.push(HealthIssue {
                severity: "error",
                code: "default_missing_key",
                message:
                    "Your default connection has no API key. Add it in Settings → Providers."
                        .into(),
            });
        }
    }

    // 5) At least one mode?
    let modes = state.catalog.list_modes().await?;
    if modes.is_empty() {
        issues.push(HealthIssue {
            severity: "error",
            code: "no_modes",
            message: "No prompt modes available. Restore defaults or create one in Modes."
                .into(),
        });
    }

    let ok = !issues.iter().any(|i| i.severity == "error");
    Ok(HealthReport { ok, issues })
}

/// Return the tail of the most recent log file (oldest line first). Capped
/// to the requested line count so the UI doesn't accidentally pull megabytes.
#[tauri::command]
pub async fn get_recent_logs(
    state: State<'_, AppState>,
    lines: Option<usize>,
) -> Result<Vec<String>, AppError> {
    let cap = lines.unwrap_or(120).min(2000);
    let dir = &state.config.log_dir;
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| AppError::Config(format!("read_dir {}: {e}", dir.display())))?
        .filter_map(|r| r.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("vibeprompter.log")
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());
    let latest = match entries.into_iter().last() {
        Some(e) => e.path(),
        None => return Ok(Vec::new()),
    };
    let body = std::fs::read_to_string(&latest)
        .map_err(|e| AppError::Config(format!("read {}: {e}", latest.display())))?;
    let lines: Vec<String> = body.lines().rev().take(cap).map(|s| s.to_string()).collect();
    Ok(lines.into_iter().rev().collect())
}
