//! The `#[tauri::command]` surface (plan §3.4). These are thin: argument marshalling, config
//! lookup, then straight into `gitwt`/`config`/`pty`. No worktree logic lives here.

use tauri::AppHandle;

use crate::config::{self, DeckConfig, GitWtResolution, RootValidation};
use crate::error::DeckResult;
use crate::gitwt::{self, RawSnapshot};

/* ------------------------------------------------------------------ config */

#[tauri::command]
pub fn get_config(app: AppHandle) -> DeckResult<DeckConfig> {
    config::load(&app)
}

#[tauri::command]
pub fn set_config(app: AppHandle, config: DeckConfig) -> DeckResult<()> {
    config::save(&app, &config)
}

#[tauri::command]
pub fn validate_root(path: String) -> RootValidation {
    config::validate_root(&path)
}

#[tauri::command]
pub fn resolve_gitwt(app: AppHandle) -> DeckResult<GitWtResolution> {
    let cfg = config::load(&app)?;
    Ok(config::resolve_gitwt(&cfg))
}

/* -------------------------------------------------------------------- list */

/// Fans `git-wt list` out across every configured repo (REQ-2).
///
/// Resolving the binary is the one failure that is fatal for the *whole* call — without
/// worktrunk there is nothing to list, and the UI shows the first-run/setup gate instead
/// (TASK-20). Per-repo failures stay per-repo (REQ-15).
#[tauri::command]
pub async fn list_worktrees(app: AppHandle, full: bool) -> DeckResult<RawSnapshot> {
    let cfg = config::load(&app)?;
    let bin = config::locate_gitwt(&cfg)?;
    Ok(gitwt::list_all(&cfg, bin, full).await)
}
