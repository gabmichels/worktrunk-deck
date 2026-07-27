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
use crate::terminals;

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

/// The working tree's changed paths, for the card's status detail view.
#[tauri::command]
pub async fn git_status(worktree_path: String) -> DeckResult<git::WorkingTreeStatus> {
    git::status(std::path::Path::new(&worktree_path)).await
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

/// The terminals this build knows about, each flagged with whether it is installed here.
///
/// Detection happens in Rust rather than the UI because it is a filesystem probe: the webview
/// cannot see `PATH`, `/Applications`, or `%ProgramFiles%`.
#[tauri::command]
pub fn list_terminals() -> Vec<terminals::TerminalChoice> {
    terminals::list()
}

/* --------------------------------------------------------------- run dev */

/// How "Run dev" should start the server for one worktree.
///
/// Deciding this in Rust keeps one answer for both destinations — the integrated PTY and the OS
/// terminal — instead of two frontends re-deriving it and drifting.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPlan {
    /// `"alias"` — worktrunk's `dev` alias; `"config"` — the deck's own per-repo setting;
    /// `"none"` — neither, so the caller must ask.
    pub source: &'static str,
    /// The command line to run, in shell syntax. Empty when `source == "none"`.
    ///
    /// A *line*, not argv: an expanded alias arrives from worktrunk as one already-quoted
    /// string, and splitting then re-joining it would only lose quoting.
    pub command_line: String,
    /// The same command as PTY argv — the line handed to a shell, which is what parses it.
    pub argv: Vec<String>,
    pub cwd: String,
    /// The alias template, unexpanded, for Settings to show. `None` unless `source == "alias"`.
    pub alias: Option<String>,
}

/// Works out what "Run dev" should run in `worktree_path`.
///
/// worktrunk's alias wins over the deck's own setting. A repo that declares
/// `[aliases] dev` in `.config/wt.toml` has already said which directory the server lives in
/// and which port this worktree gets — both versioned with the repo and shared by everyone
/// working in it. Re-specifying that in deck settings would be a second source of truth that
/// silently disagrees the moment either side changes.
#[tauri::command]
pub async fn dev_plan(
    app: AppHandle,
    repo_path: String,
    worktree_path: String,
) -> DeckResult<DevPlan> {
    let cfg = config::load(&app)?;
    let worktree = std::path::PathBuf::from(&worktree_path);

    if let Ok(bin) = config::locate_gitwt(&cfg) {
        // Probed on the **worktree**, not the repo. `.config/wt.toml` is versioned content: a
        // branch created before the alias was committed genuinely does not have it, and
        // claiming otherwise would hand the terminal a command that cannot run there.
        if let Some(command_line) = gitwt::dev_command_line(&bin, &worktree).await {
            return Ok(DevPlan {
                source: "alias",
                argv: pty::shell_argv(&command_line),
                command_line,
                // The alias runs from the worktree root; where the server actually lives is the
                // alias's own business (`pnpm --filter web`, a `-C`, a `cd` — worktrunk's call).
                cwd: worktree_path,
                alias: gitwt::dev_alias(&bin, &worktree).await,
            });
        }
    }

    match cfg.dev_for(&repo_path) {
        Some(dev) if !dev.command.is_empty() => {
            let command_line = external::join_command(&dev.command);
            Ok(DevPlan {
                source: "config",
                // Spawned directly: this one is argv already, so it needs no shell to parse it.
                argv: dev.command.clone(),
                command_line,
                cwd: config::resolve_dev_cwd(&worktree_path, dev.cwd.as_deref()),
                alias: None,
            })
        }
        _ => Ok(DevPlan {
            source: "none",
            command_line: String::new(),
            argv: Vec::new(),
            cwd: worktree_path,
            alias: None,
        }),
    }
}

/// The `dev` alias template for a path, or `None`. Settings uses it to show what "Run dev" will
/// run, and to explain why the deck's own command field is not being used.
#[tauri::command]
pub async fn dev_alias(app: AppHandle, repo_path: String) -> DeckResult<Option<String>> {
    let cfg = config::load(&app)?;
    let Ok(bin) = config::locate_gitwt(&cfg) else {
        return Ok(None);
    };
    Ok(gitwt::dev_alias(&bin, std::path::Path::new(&repo_path)).await)
}

/// Opens the OS terminal at `cwd`, running `dev_command` in it when one is given (REQ-8).
///
/// Both the command and the directory are passed in rather than looked up here. The caller is
/// the only one that knows whether this is "Open terminal" or "Run dev", and for a dev run it
/// already holds the resolved plan. Reading them from the config instead meant an external
/// "Open terminal" silently started the dev server, and an external "Run dev" on an
/// unconfigured repo silently opened a bare shell — the click appeared to do nothing.
///
/// Returns a note when the selected terminal could not be used, so the caller can say so
/// instead of leaving the user staring at a terminal they did not choose.
#[tauri::command]
pub fn run_external(
    app: AppHandle,
    cwd: String,
    dev_command: Option<String>,
) -> DeckResult<Option<String>> {
    let cfg = config::load(&app)?;
    let dev = dev_command.filter(|c| !c.trim().is_empty());
    external::run_external(&cwd, dev.as_deref(), cfg.external_terminal.as_deref())
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
