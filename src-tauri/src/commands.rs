//! The `#[tauri::command]` surface (plan §3.4). These are thin: argument marshalling, config
//! lookup, then straight into `gitwt`/`pty`/`external`/`config`. No worktree logic lives here.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::config::{self, DeckConfig, GitWtResolution, RootValidation};
use crate::error::DeckResult;
use crate::external;
use crate::git;
use crate::gitwt::{self, CliResult, RawSnapshot, Subcommand};
use crate::pty::{self, PtyRegistry};

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

/// The host OS, so the setup screen can show the right worktrunk install command.
///
/// Read from the compiled target rather than the webview's user-agent string, which lies on
/// some Linux WebKit builds and tells us about the renderer rather than the machine.
#[tauri::command]
pub fn host_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
pub fn resolve_gitwt(app: AppHandle) -> DeckResult<GitWtResolution> {
    let cfg = config::load(&app)?;
    Ok(config::resolve_gitwt(&cfg))
}

/* -------------------------------------------------------------------- list */

/// Fans `git-wt list` out across every configured repo (REQ-2).
///
/// Resolving the binary is the one failure fatal to the *whole* call — without worktrunk there
/// is nothing to list, and the UI shows the setup gate instead. Per-repo failures stay
/// per-repo (REQ-15).
#[tauri::command]
pub async fn list_worktrees(app: AppHandle, full: bool) -> DeckResult<RawSnapshot> {
    let cfg = config::load(&app)?;
    let bin = config::locate_gitwt(&cfg)?;
    Ok(gitwt::list_all(&cfg, bin, full).await)
}

/* -------------------------------------------------------- lifecycle actions */

/// `git-wt remove` (REQ-6), buffered.
///
/// A non-zero exit is returned as `ok: false` with worktrunk's stderr rather than as an error:
/// its refusal to remove a dirty worktree is information the user needs to read, not a crash
/// (TASK-10).
#[tauri::command]
pub async fn remove_worktree(
    app: AppHandle,
    repo_path: String,
    branch: String,
    force: bool,
) -> DeckResult<CliResult> {
    let cfg = config::load(&app)?;
    let bin = config::locate_gitwt(&cfg)?;

    let mut args = vec![branch];
    if force {
        args.push("--force".into());
    }

    gitwt::run(
        &bin,
        std::path::Path::new(&repo_path),
        Subcommand::Remove,
        &args,
    )
    .await
}

/* ----------------------------------------------------------------- history */

/// One page of a worktree's commit history, for the expanded card.
///
/// The only `git` call in the app; see `git.rs` for why it is safe to have exactly one.
#[tauri::command]
pub async fn list_commits(
    worktree_path: String,
    skip: u32,
    limit: u32,
) -> DeckResult<Vec<git::Commit>> {
    git::log(std::path::Path::new(&worktree_path), skip, limit).await
}

/* ----------------------------------------------- interactive worktrunk tasks */

/// Builds the full argv (binary first) for running a worktrunk subcommand inside a PTY.
///
/// The frontend never names the binary or the subcommand — it passes a repo and a branch, and
/// the allowlisted [`Subcommand`] is chosen here. `pty_open` would technically accept an
/// arbitrary command, so routing these through a dedicated command keeps NFR-3's guarantee
/// intact rather than relying on the webview to be well behaved.
fn gitwt_pty_argv(
    app: &AppHandle,
    repo_path: &str,
    sub: Subcommand,
    args: &[String],
) -> DeckResult<Vec<String>> {
    let cfg = config::load(app)?;
    let bin = config::locate_gitwt(&cfg)?;
    let mut argv = vec![bin.to_string_lossy().into_owned()];
    argv.extend(gitwt::build_args(
        std::path::Path::new(repo_path),
        sub,
        args,
    ));
    Ok(argv)
}

/// `git-wt switch --create <branch>` in a **pseudo-terminal** (REQ-5).
///
/// Not a piped child: worktrunk asks for interactive approval the first time a repo's project
/// hooks run ("needs approval to execute 3 commands"), and it will not accept `--yes` from a
/// non-interactive shell. Streaming through a pipe means that prompt can be *displayed* but
/// never *answered*, so the run hangs forever with no way out. A PTY makes it a normal terminal
/// the user can type into — and Ctrl-C out of.
#[tauri::command]
pub fn create_worktree_pty(
    app: AppHandle,
    registry: State<'_, Arc<PtyRegistry>>,
    repo_path: String,
    branch: String,
) -> DeckResult<String> {
    let argv = gitwt_pty_argv(
        &app,
        &repo_path,
        Subcommand::Switch,
        &["--create".to_string(), branch],
    )?;
    pty::open(&app, &registry, &repo_path, Some(argv))
}

/// `git-wt merge` in a PTY, for the same reason as [`create_worktree_pty`] — merge can stop to
/// ask about conflicts or confirmation.
#[tauri::command]
pub fn merge_worktree_pty(
    app: AppHandle,
    registry: State<'_, Arc<PtyRegistry>>,
    repo_path: String,
    branch: String,
) -> DeckResult<String> {
    let argv = gitwt_pty_argv(&app, &repo_path, Subcommand::Merge, &[branch])?;
    pty::open(&app, &registry, &repo_path, Some(argv))
}

/* ------------------------------------------------------------- open / launch */

#[tauri::command]
pub fn open_in_editor(path: String) -> DeckResult<()> {
    external::open_in_editor(&path)
}

#[tauri::command]
pub fn open_url(url: String) -> DeckResult<()> {
    external::open_url(&url)
}

/// Reveals a worktree in Explorer / Finder / the XDG file manager.
#[tauri::command]
pub fn open_in_file_manager(path: String) -> DeckResult<()> {
    external::open_in_file_manager(&path)
}

/// Launches the repo's dev command in the OS terminal instead of the integrated one (REQ-8).
#[tauri::command]
pub fn run_external(app: AppHandle, repo_path: String, worktree_path: String) -> DeckResult<()> {
    let cfg = config::load(&app)?;
    let dev = cfg.dev_for(&repo_path);

    // Honour the configured working directory here too, so "Run externally" and the integrated
    // terminal start the server in the same place — a monorepo's dev command lives in a
    // subdirectory of the worktree, not at its root.
    let dir = config::resolve_dev_cwd(&worktree_path, dev.as_ref().and_then(|d| d.cwd.as_deref()));

    external::run_external(
        &dir,
        dev.as_ref().map(|d| d.command.as_slice()),
        cfg.external_terminal.as_deref(),
    )
}

/* --------------------------------------------------------------------- PTY */

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    registry: State<'_, Arc<PtyRegistry>>,
    cwd: String,
    cmd: Option<Vec<String>>,
) -> DeckResult<String> {
    pty::open(&app, &registry, &cwd, cmd)
}

#[tauri::command]
pub fn pty_write(
    registry: State<'_, Arc<PtyRegistry>>,
    session_id: String,
    data: String,
) -> DeckResult<()> {
    pty::write(&registry, &session_id, &data)
}

#[tauri::command]
pub fn pty_resize(
    registry: State<'_, Arc<PtyRegistry>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> DeckResult<()> {
    pty::resize(&registry, &session_id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(registry: State<'_, Arc<PtyRegistry>>, session_id: String) -> DeckResult<()> {
    pty::kill(&registry, &session_id)
}

/// Live session count, for the header's running indicator (TASK-17).
#[tauri::command]
pub fn pty_session_count(registry: State<'_, Arc<PtyRegistry>>) -> usize {
    pty::session_count(&registry)
}
