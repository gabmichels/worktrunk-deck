//! The **only** place that knows how to talk to worktrunk (plan §3.5, NFR-6).
//!
//! Two rules hold everywhere in this module:
//!
//! 1. **Allowlist.** Only `list`, `switch`, `merge` and `remove` may ever be spawned. The
//!    webview cannot spawn processes at all, and even the Rust callers go through
//!    [`Subcommand`], so a future command cannot quietly widen the surface (NFR-3).
//! 2. **Explicit `-C <repo>`.** We never rely on the process working directory — the deck runs
//!    from wherever the OS launched it, which is not any repo.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::task::JoinSet;

use crate::config::DeckConfig;
use crate::error::{DeckError, DeckResult};
use crate::process::async_command;

/// The complete set of worktrunk subcommands the deck may invoke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subcommand {
    List,
    Switch,
    Merge,
    Remove,
    /// `config alias show` — reports the repo's alias templates and runs none of them.
    ///
    /// Deliberately *not* a general `config` variant. That subcommand also reaches
    /// `approvals add`, `state` and `create`, which write; this one names the whole read-only
    /// invocation so no caller can widen it by passing different args (see [`Self::fixed_args`]).
    ConfigAliasShow,
}

impl Subcommand {
    pub fn as_str(self) -> &'static str {
        match self {
            Subcommand::List => "list",
            Subcommand::Switch => "switch",
            Subcommand::Merge => "merge",
            Subcommand::Remove => "remove",
            Subcommand::ConfigAliasShow => "config",
        }
    }

    /// Args baked into the variant, placed before any caller args. This is what lets a variant
    /// mean one specific invocation rather than a whole subcommand tree.
    fn fixed_args(self) -> &'static [&'static str] {
        match self {
            Subcommand::ConfigAliasShow => &["alias", "show"],
            _ => &[],
        }
    }

    /// Parses a subcommand name, rejecting anything outside the allowlist (NFR-3).
    ///
    /// Currently unused in production, and deliberately so: the command surface takes a
    /// [`Subcommand`] value rather than a string, which makes the allowlist a *type-level*
    /// guarantee that cannot be bypassed at all. This function exists as the guard for any
    /// future entry point where a subcommand does arrive as a string — and the tests below
    /// pin the rejection behaviour so that guard is already proven when it is needed.
    #[allow(dead_code)]
    pub fn parse(name: &str) -> DeckResult<Self> {
        match name {
            "list" => Ok(Subcommand::List),
            "switch" => Ok(Subcommand::Switch),
            "merge" => Ok(Subcommand::Merge),
            "remove" => Ok(Subcommand::Remove),
            // `config` is intentionally absent: `ConfigAliasShow` is constructible only in Rust,
            // so a bare "config" arriving as a string stays rejected along with everything else.
            other => Err(DeckError::NotAllowed(other.to_string())),
        }
    }
}

/// Builds the full argv for a worktrunk invocation: `-C <repo> <subcommand> <args…>`.
pub fn build_args(repo: &Path, sub: Subcommand, args: &[String]) -> Vec<String> {
    let mut all = vec![
        "-C".to_string(),
        repo.to_string_lossy().into_owned(),
        sub.as_str().to_string(),
    ];
    all.extend(sub.fixed_args().iter().map(|a| a.to_string()));
    all.extend_from_slice(args);
    all
}

/// Result of a buffered invocation, surfaced verbatim to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a worktrunk subcommand to completion and returns its output.
///
/// A non-zero exit is *not* an error here — callers such as `remove` want to show worktrunk's
/// refusal text to the user rather than a generic failure (TASK-10).
pub async fn run(
    bin: &Path,
    repo: &Path,
    sub: Subcommand,
    args: &[String],
) -> DeckResult<CliResult> {
    let argv = build_args(repo, sub, args);
    let output =
        async_command(bin).args(&argv).output().await.map_err(|e| {
            DeckError::GitWtMissing(format!("cannot execute {}: {e}", bin.display()))
        })?;

    Ok(CliResult {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Like [`run`], but a non-zero exit becomes a `DeckError` carrying worktrunk's stderr. Used
/// where there is nothing sensible to render from a failed run (e.g. `list`).
pub async fn run_checked(
    bin: &Path,
    repo: &Path,
    sub: Subcommand,
    args: &[String],
) -> DeckResult<String> {
    let result = run(bin, repo, sub, args).await?;
    if result.ok {
        return Ok(result.stdout);
    }
    let detail = if result.stderr.trim().is_empty() {
        result.stdout.trim().to_string()
    } else {
        result.stderr.trim().to_string()
    };
    Err(DeckError::GitWtFailed {
        args: build_args(repo, sub, args).join(" "),
        code: "non-zero".into(),
        stderr: detail,
    })
}

/* ----------------------------------------------------------------- aliases */

/// The repo's `dev` alias template, or `None` when it has none.
///
/// A repo that configures `[aliases] dev` in `.config/wt.toml` has already answered both
/// questions the deck would otherwise ask: *which* directory the server lives in, and *which*
/// port this worktree gets. cw-rag-core's is
/// `pnpm --filter web dev -- --port {{ branch | hash_port }}` — the subdirectory and the port
/// in one line, versioned with the repo. Reading it beats duplicating it in deck settings, and
/// keeps worktrunk the single source of truth for a worktree's port (plan §3.5).
///
/// Returned **unexpanded**, template braces and all: it is display text for Settings, never
/// something to run. Running it is worktrunk's job — see `dev_argv`.
pub async fn dev_alias(bin: &Path, repo: &Path) -> Option<String> {
    let result = run(bin, repo, Subcommand::ConfigAliasShow, &[]).await.ok()?;
    if !result.ok {
        return None;
    }
    parse_dev_alias(&result.stdout)
}

/// Pulls the `dev` template out of `git-wt config alias show`, whose output looks like:
///
/// ```text
/// ○ Alias dev (project):
///   pnpm --filter web dev -- --port {{ branch | hash_port }}
/// ○ Alias url (project):
///   echo http://localhost:{{ branch | hash_port }}
/// ```
///
/// The template is the line *after* its header, so this is a two-line scan rather than a regex
/// over the whole blob. Anything that does not match that shape yields `None` — an unreadable
/// alias must look like "no alias" and fall back to the deck's own setting, never like an
/// empty command.
fn parse_dev_alias(stdout: &str) -> Option<String> {
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        let header = line.trim_start_matches(['○', '●', '✓', ' ']).trim();
        // `(project)` or `(user)` — the scope is irrelevant, only that this is the dev alias.
        if !header.starts_with("Alias dev ") && header != "Alias dev:" {
            continue;
        }
        let template = lines.next()?.trim();
        return (!template.is_empty()).then(|| template.to_string());
    }
    None
}

/// The argv that runs the repo's `dev` alias in `worktree`.
///
/// `dev` is an *alias*, not a subcommand: `git-wt.exe dev` exits with "unrecognized subcommand".
/// The shell wrapper worktrunk installs is what turns it into the expanded command, so this has
/// to be run through a shell that loads the user's profile — which is exactly what an interactive
/// terminal does, and why this returns argv for a terminal rather than something to spawn
/// directly.
pub fn dev_argv() -> Vec<String> {
    vec!["git-wt".to_string(), "dev".to_string()]
}

#[cfg(test)]
mod alias_tests {
    use super::parse_dev_alias;

    /// Verbatim from `git-wt v0.60.0 -C C:\Workspace\cw-rag-core config alias show`.
    const REAL_OUTPUT: &str = "\
○ Alias dev (project):
  pnpm --filter web dev -- --port {{ branch | hash_port }}
○ Alias url (project):
  echo http://localhost:{{ branch | hash_port }}
";

    #[test]
    fn reads_the_dev_template_from_real_output() {
        assert_eq!(
            parse_dev_alias(REAL_OUTPUT).as_deref(),
            Some("pnpm --filter web dev -- --port {{ branch | hash_port }}")
        );
    }

    /// `dev` is not always first, and `url`'s template must not be mistaken for it.
    #[test]
    fn picks_dev_rather_than_whichever_alias_comes_first() {
        let reordered = "\
○ Alias url (project):
  echo http://localhost:{{ branch | hash_port }}
○ Alias dev (user):
  pnpm dev
";
        assert_eq!(parse_dev_alias(reordered).as_deref(), Some("pnpm dev"));
    }

    /// worktrunk-deck's own repo. No alias must read as "none" so the deck's setting is used.
    #[test]
    fn a_repo_without_aliases_has_no_dev_command() {
        assert_eq!(parse_dev_alias("○ No aliases configured\n"), None);
        assert_eq!(parse_dev_alias(""), None);
    }

    /// A name that merely starts with "dev" is a different alias.
    #[test]
    fn a_similarly_named_alias_is_not_the_dev_alias() {
        let other = "○ Alias devtools (project):\n  echo nope\n";
        assert_eq!(parse_dev_alias(other), None);
    }

    /// A header with nothing under it would otherwise yield an empty command, which reads as
    /// "run nothing" — the exact silent failure this whole change is about.
    #[test]
    fn a_header_with_no_template_is_not_an_empty_command() {
        assert_eq!(parse_dev_alias("○ Alias dev (project):\n"), None);
        assert_eq!(parse_dev_alias("○ Alias dev (project):\n\n"), None);
    }
}

/* ------------------------------------------------------------- list fan-out */

/// One repo's worth of `git-wt list` output, **unnormalized**.
///
/// The rows stay as raw JSON on purpose: the mapping to the UI's `Worktree` type lives in
/// `src/lib/adapter.ts`, where it is a pure function tested against recorded worktrunk fixtures
/// (plan §8, TASK-6). Rust's job is fan-out and error isolation, not interpretation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRepoResult {
    pub repo: String,
    pub repo_path: String,
    /// `"ok"` or `"unreadable"` (REQ-15).
    pub load: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub worktrees: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSnapshot {
    pub repos: Vec<RawRepoResult>,
    pub generated_at: u64,
}

impl RawRepoResult {
    fn unreadable(repo_path: &Path, error: String) -> Self {
        Self {
            repo: display_name(repo_path),
            repo_path: repo_path.to_string_lossy().into_owned(),
            load: "unreadable",
            error: Some(error),
            worktrees: Vec::new(),
        }
    }
}

fn display_name(repo_path: &Path) -> String {
    repo_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo_path.to_string_lossy().into_owned())
}

/// Lists every configured repo **in parallel** and returns one entry per repo.
///
/// A repo that fails — bad path, not a git repo, worktrunk error — becomes an `unreadable`
/// entry carrying its stderr. It never aborts or delays the others (REQ-15, NFR-4/5).
pub async fn list_all(config: &DeckConfig, bin: PathBuf, full: bool) -> RawSnapshot {
    let repos = config.effective_repos();

    let mut set: JoinSet<(usize, RawRepoResult)> = JoinSet::new();
    for (index, repo) in repos.into_iter().enumerate() {
        let bin = bin.clone();
        set.spawn(async move { (index, list_one(&bin, &repo, full).await) });
    }

    let mut collected: Vec<(usize, RawRepoResult)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(pair) => collected.push(pair),
            // A panicking task must not take the whole refresh down with it.
            Err(e) => log::error!("git-wt list task failed to join: {e}"),
        }
    }
    // Restore configured order — completion order is nondeterministic and the list must not
    // reshuffle itself on every refresh.
    collected.sort_by_key(|(i, _)| *i);

    RawSnapshot {
        repos: collected.into_iter().map(|(_, r)| r).collect(),
        generated_at: now_ms(),
    }
}

async fn list_one(bin: &Path, repo: &Path, full: bool) -> RawRepoResult {
    if !repo.exists() {
        return RawRepoResult::unreadable(repo, format!("{} does not exist.", repo.display()));
    }

    let mut args = vec!["--format".to_string(), "json".to_string()];
    if full {
        args.push("--full".to_string());
    }

    let stdout = match run_checked(bin, repo, Subcommand::List, &args).await {
        Ok(s) => s,
        Err(e) => return RawRepoResult::unreadable(repo, e.to_string()),
    };

    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(serde_json::Value::Array(rows)) => RawRepoResult {
            repo: display_name(repo),
            repo_path: repo.to_string_lossy().into_owned(),
            load: "ok",
            error: None,
            worktrees: rows,
        },
        Ok(other) => RawRepoResult::unreadable(
            repo,
            format!(
                "expected a JSON array from `git-wt list --format json`, got {}",
                kind_of(&other)
            ),
        ),
        Err(e) => RawRepoResult::unreadable(repo, DeckError::BadJson(e.to_string()).to_string()),
    }
}

fn kind_of(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_exactly_the_four_documented_subcommands() {
        for name in ["list", "switch", "merge", "remove"] {
            assert!(Subcommand::parse(name).is_ok(), "{name} should be allowed");
        }
    }

    #[test]
    fn allowlist_rejects_everything_else() {
        for name in [
            "",
            "exec",
            "config",
            "rm",
            "List",
            "list;rm -rf /",
            "--version",
        ] {
            assert!(
                matches!(Subcommand::parse(name), Err(DeckError::NotAllowed(_))),
                "{name} must be rejected"
            );
        }
    }

    /// The alias probe must stay pinned to `config alias show`. Widening it to a bare `config`
    /// would put `approvals add` and `state` — both of which write — inside the allowlist.
    #[test]
    fn the_alias_probe_is_pinned_to_one_read_only_invocation() {
        let argv = build_args(Path::new("/repo"), Subcommand::ConfigAliasShow, &[]);
        assert_eq!(argv, ["-C", "/repo", "config", "alias", "show"]);
    }

    #[test]
    fn args_always_lead_with_dash_c_and_the_repo() {
        let argv = build_args(
            Path::new("/repos/demo"),
            Subcommand::List,
            &["--format".into(), "json".into()],
        );
        assert_eq!(argv[0], "-C");
        assert_eq!(argv[1], "/repos/demo");
        assert_eq!(argv[2], "list");
        assert_eq!(&argv[3..], &["--format".to_string(), "json".to_string()]);
    }

    #[tokio::test]
    async fn a_missing_repo_directory_is_unreadable_not_a_panic() {
        let r = list_one(
            Path::new("git-wt"),
            Path::new("/definitely/not/a/repo/anywhere"),
            false,
        )
        .await;
        assert_eq!(r.load, "unreadable");
        assert!(r.error.is_some());
        assert!(r.worktrees.is_empty());
    }
}
