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
    // Pull everything — the panel's filter operates client-side, so an
    // export of "all history" is what the user expects.
    let items = state
        .history
        .list(crate::models::HistoryQuery { limit: 100_000, offset: 0 })
        .await?;
    Ok(serde_json::json!({
        "schema": "vibeprompter-history-v1",
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "count": items.len(),
        "items": items,
    }))
}
