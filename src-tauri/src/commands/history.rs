//! History commands — thin IPC adapters over `HistoryService`.

use serde::Serialize;
use tauri::State;

use crate::app::AppState;
use crate::models::{HistoryItem, HistoryQuery};
use crate::utils::AppError;

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    query: Option<HistoryQuery>,
) -> Result<Vec<HistoryItem>, AppError> {
    state.history.list(query.unwrap_or_default()).await
}

/// Tweaks/followups nested under a history entry, oldest-first. Returns an
/// empty list for entries that were never tweaked.
#[tauri::command]
pub async fn get_history_children(
    state: State<'_, AppState>,
    parent_id: i64,
) -> Result<Vec<HistoryItem>, AppError> {
    state.history.children_of(parent_id).await
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> Result<u64, AppError> {
    state.history.clear().await
}

#[tauri::command]
pub async fn count_history(state: State<'_, AppState>) -> Result<i64, AppError> {
    state.history.count().await
}

#[tauri::command]
pub async fn set_history_favorite(
    state: State<'_, AppState>,
    id: i64,
    favorite: bool,
) -> Result<(), AppError> {
    state.history.set_favorite(id, favorite).await
}

#[derive(Debug, Serialize)]
pub struct CostSummary {
    /// Total micro-dollars spent in the last 30 days.
    #[serde(rename = "monthMicros")]
    pub month_micros: i64,
    /// Total micro-dollars spent in the last 7 days.
    #[serde(rename = "weekMicros")]
    pub week_micros: i64,
    /// Total micro-dollars across all kept history.
    #[serde(rename = "totalMicros")]
    pub total_micros: i64,
    /// Number of runs in the last 30 days that have a non-zero cost (i.e.
    /// the model had a pricing entry and the vendor reported usage).
    #[serde(rename = "monthRunsPriced")]
    pub month_runs_priced: i64,
    /// Number of runs in the last 30 days with zero cost (local models /
    /// unknown pricing). Lets the UI clarify "$X.XX from N priced runs;
    /// M local runs not counted".
    #[serde(rename = "monthRunsUnpriced")]
    pub month_runs_unpriced: i64,
}

#[derive(Debug, Serialize)]
pub struct CostByDay {
    pub day: String,
    #[serde(rename = "micros")]
    pub micros: i64,
    pub runs: i64,
}

#[derive(Debug, Serialize)]
pub struct CostByConnection {
    pub label: String,
    pub micros: i64,
    pub runs: i64,
}

#[derive(Debug, Serialize)]
pub struct CostBreakdown {
    #[serde(rename = "byDay")]
    pub by_day: Vec<CostByDay>,
    #[serde(rename = "byConnection")]
    pub by_connection: Vec<CostByConnection>,
    pub days: i64,
}

#[tauri::command]
pub async fn get_cost_breakdown(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> Result<CostBreakdown, AppError> {
    let days = days.unwrap_or(30).clamp(1, 365);
    let by_day = state
        .history
        .cost_by_day(days)
        .await?
        .into_iter()
        .map(|(day, micros, runs)| CostByDay { day, micros, runs })
        .collect();
    let by_connection = state
        .history
        .cost_by_connection(days)
        .await?
        .into_iter()
        .map(|(label, micros, runs)| CostByConnection { label, micros, runs })
        .collect();
    Ok(CostBreakdown {
        by_day,
        by_connection,
        days,
    })
}

#[tauri::command]
pub async fn get_cost_summary(
    state: State<'_, AppState>,
) -> Result<CostSummary, AppError> {
    let (month_micros, week_micros, total_micros, priced, unpriced) =
        state.history.cost_summary().await?;
    Ok(CostSummary {
        month_micros,
        week_micros,
        total_micros,
        month_runs_priced: priced,
        month_runs_unpriced: unpriced,
    })
}

/// Export the entire history as JSON. Returned as a serde value the frontend
/// stringifies and writes to disk via the browser's download API.
#[tauri::command]
pub async fn export_history(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let items = state
        .history
        .list_all(crate::models::HistoryQuery { limit: 100_000, offset: 0 })
        .await?;
    Ok(serde_json::json!({
        "schema": "vibeprompter-history-v1",
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "count": items.len(),
        "items": items,
    }))
}

/// Show a native save-file dialog, then write history JSON to the chosen path.
/// Returns the path that was written, or null if the user cancelled.
#[tauri::command]
pub async fn export_history_to_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::{DialogExt, FilePath};

    let default_name = format!(
        "vibeprompter-history-{}.json",
        chrono::Utc::now().format("%Y-%m-%d")
    );

    // Show the native save dialog synchronously via a oneshot channel so we
    // can stay inside an async command without blocking the Tauri runtime.
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .set_title("Export history")
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let path = rx.await.map_err(|_| AppError::Config("dialog closed".into()))?;
    let Some(file_path) = path else {
        return Ok(None); // user cancelled
    };

    let items = state
        .history
        .list_all(crate::models::HistoryQuery { limit: 100_000, offset: 0 })
        .await?;
    let payload = serde_json::json!({
        "schema": "vibeprompter-history-v1",
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "count": items.len(),
        "items": items,
    });
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| AppError::Config(format!("serialise: {e}")))?;

    let dest = file_path.as_path()
        .ok_or_else(|| AppError::Config("invalid path".into()))?;
    std::fs::write(dest, json.as_bytes())
        .map_err(|e| AppError::Config(format!("write {}: {e}", dest.display())))?;

    Ok(Some(dest.display().to_string()))
}
