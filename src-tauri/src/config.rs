//! Deck configuration: persistence, repo discovery, and locating the `git-wt` binary
//! (plan §3.3, §5). This module owns *no* worktree knowledge — it only answers
//! "which repos?" and "which binary?".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{DeckError, DeckResult};
use crate::process::command;

/// Minimum worktrunk version whose `list --format json` shape we are written against (spec Q3).
pub const MIN_GITWT_VERSION: &str = "0.60.0";

fn default_auto_refresh_ms() -> u64 {
    5_000
}

fn default_confirm_destructive() -> bool {
    true
}

fn default_version() -> u32 {
    1
}

fn default_theme() -> String {
    "system".to_string()
}

/// Mirrors `DeckConfig` in `src/lib/types.ts` (plan §3.3). Every field has a default so a
/// config written by an older build still loads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    pub repos: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_wt_path: Option<String>,
    #[serde(default = "default_auto_refresh_ms")]
    pub auto_refresh_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_terminal: Option<String>,
    /// Route "Open terminal" / "Run dev" to the OS terminal instead of the embedded one (REQ-8).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefer_external_terminal: Option<bool>,
    #[serde(default = "default_confirm_destructive")]
    pub confirm_destructive: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    pub cross_repo_grouping: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev_by_repo: Option<std::collections::HashMap<String, DevCommand>>,
    /// Repos the user hid from the dashboard. Kept apart from `repos` so hiding is reversible
    /// without losing the configured path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_repos: Option<Vec<String>>,
    /// Superseded by [`DeckConfig::dev_by_repo`], read once so an existing config keeps its
    /// dev commands. Never written back — [`DeckConfig::migrate`] folds it into the new field.
    #[serde(default, skip_serializing)]
    dev_command_by_repo: Option<std::collections::HashMap<String, Vec<String>>>,
}

/// A repo's dev command and where to run it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevCommand {
    pub command: Vec<String>,
    /// Relative to the **worktree** root, not the repo root — monorepos keep the dev server in
    /// e.g. `apps/web`, and every worktree has its own copy of that tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl Default for DeckConfig {
    fn default() -> Self {
        Self {
            version: default_version(),
            repos: Vec::new(),
            scan_root: None,
            git_wt_path: None,
            auto_refresh_ms: default_auto_refresh_ms(),
            external_terminal: None,
            prefer_external_terminal: None,
            confirm_destructive: default_confirm_destructive(),
            theme: default_theme(),
            cross_repo_grouping: false,
            dev_by_repo: None,
            hidden_repos: None,
            dev_command_by_repo: None,
        }
    }
}

impl DeckConfig {
    /// Every repo the deck should list: the explicit list plus anything discovered under
    /// `scan_root`, de-duplicated and stably ordered (REQ-1).
    pub fn effective_repos(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let push =
            |p: PathBuf, out: &mut Vec<PathBuf>, seen: &mut std::collections::HashSet<String>| {
                let key = normalize_key(&p);
                if seen.insert(key) {
                    out.push(p);
                }
            };

        for r in &self.repos {
            push(PathBuf::from(r), &mut out, &mut seen);
        }
        if let Some(root) = &self.scan_root {
            for r in discover_repos(Path::new(root)) {
                push(r, &mut out, &mut seen);
            }
        }
        // Hiding is applied last so it covers explicit entries and scanned ones alike.
        out.retain(|p| !self.is_hidden(p));
        out
    }

    /// Dev command for a repo. `None` means the UI should ask.
    pub fn dev_for(&self, repo_path: &str) -> Option<DevCommand> {
        let map = self.dev_by_repo.as_ref()?;
        // Match on the normalized path so `C:\x` and `C:/x` are the same key.
        let want = normalize_key(Path::new(repo_path));
        map.iter()
            .find(|(k, _)| normalize_key(Path::new(k)) == want)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.command.is_empty())
    }

    /// Folds a config written by an older build into the current shape. Called on load so the
    /// rest of the code only ever sees `dev_by_repo`.
    fn migrate(mut self) -> Self {
        if let Some(legacy) = self.dev_command_by_repo.take() {
            let map = self.dev_by_repo.get_or_insert_with(Default::default);
            for (repo, command) in legacy {
                // A value already written in the new shape wins — it is the newer intent.
                map.entry(repo).or_insert(DevCommand { command, cwd: None });
            }
        }
        self
    }

    fn is_hidden(&self, path: &Path) -> bool {
        let Some(hidden) = self.hidden_repos.as_ref() else {
            return false;
        };
        let want = normalize_key(path);
        hidden.iter().any(|h| normalize_key(Path::new(h)) == want)
    }
}

/// Resolves a dev command's working directory against a worktree.
///
/// `cwd` is relative to the **worktree**, never the repo: a monorepo keeps its dev server in
/// e.g. `apps/web`, and each worktree has its own copy of that subtree — resolving against the
/// repo root would start the server in the wrong checkout, defeating the isolation worktrunk
/// exists to provide.
///
/// Absolute values and `..` segments are ignored rather than honoured; the settings UI rejects
/// them, and this is the backstop for a hand-edited config file.
pub fn resolve_dev_cwd(worktree_path: &str, cwd: Option<&str>) -> String {
    let Some(rel) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return worktree_path.to_string();
    };

    let looks_absolute =
        rel.starts_with('/') || rel.starts_with('\\') || rel.chars().nth(1) == Some(':');
    let escapes = rel.split(['/', '\\']).any(|segment| segment == "..");
    if looks_absolute || escapes {
        return worktree_path.to_string();
    }

    let base = worktree_path.trim_end_matches(['/', '\\']);
    let rel = rel.trim_matches(['/', '\\']).replace('\\', "/");
    format!("{base}/{rel}")
}

/// Case- and separator-insensitive path key. Windows paths arrive from worktrunk with `/`
/// and from the OS with `\`; both must collapse to one identity.
fn normalize_key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/* ------------------------------------------------------------- persistence */

fn config_path(app: &AppHandle) -> DeckResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| DeckError::Config(format!("cannot locate the app config directory: {e}")))?;
    Ok(dir.join("config.json"))
}

/// Loads the config, falling back to defaults when the file is absent. A *corrupt* file is an
/// error rather than a silent reset — silently discarding a user's repo list would be worse.
pub fn load(app: &AppHandle) -> DeckResult<DeckConfig> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(DeckConfig::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    serde_json::from_str::<DeckConfig>(&raw)
        .map(DeckConfig::migrate)
        .map_err(|e| {
            DeckError::Config(format!(
                "{} is not valid worktrunk-deck config: {e}",
                path.display()
            ))
        })
}

pub fn save(app: &AppHandle, config: &DeckConfig) -> DeckResult<()> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| DeckError::Config(format!("cannot serialize config: {e}")))?;
    // Write-then-rename so a crash mid-write cannot truncate an existing config.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/* --------------------------------------------------------- repo discovery */

/// Repos found under `root`.
///
/// Two shapes are supported, because both are things people actually point this at:
///
/// - **A workspace directory** — the immediate children that are repos. Deliberately one level
///   deep; a recursive scan would descend into `node_modules` and into worktrees themselves.
/// - **A single repository** — if `root` is itself a checkout, it *is* the answer. Scanning its
///   children would find nothing and leave the user staring at an empty dashboard, when what
///   they meant was "show me this repo". worktrunk then lists that repo's worktrees, including
///   nested ones under `.claude/worktrees/`, so drilling into one repo hides the rest of the
///   workspace without hiding any of its own worktrees.
pub fn discover_repos(root: &Path) -> Vec<PathBuf> {
    if is_git_repo(root) {
        return vec![root.to_path_buf()];
    }

    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut repos: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_git_repo(p))
        .collect();
    repos.sort();
    repos
}

/// True for a real checkout, false for a **linked worktree**.
///
/// This distinction matters more than it looks. worktrunk's default layout puts worktrees
/// beside their repo (`demo-app`, `demo-app.feat-x`), so a scan root is full of them — and
/// `git-wt -C <linked worktree> list` happily returns *the whole repo's* worktrees. Treating
/// one as a repo therefore duplicates every card in the repo, once per worktree.
///
/// A normal checkout has a `.git` **directory**; a linked worktree has a `.git` **file**
/// containing a `gitdir:` pointer. That is the discriminator.
fn is_git_repo(path: &Path) -> bool {
    path.is_dir() && path.join(".git").is_dir()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootValidation {
    pub ok: bool,
    pub repo_count: usize,
    /// True when the chosen directory is itself a checkout rather than a folder of them, so
    /// the UI can say "this repository and its worktrees" instead of "1 repo found".
    pub root_is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Powers the settings panel's live "Workspace OK — N repos found" (REQ-13).
pub fn validate_root(path: &str) -> RootValidation {
    let invalid = |error: String| RootValidation {
        ok: false,
        repo_count: 0,
        root_is_repo: false,
        error: Some(error),
    };

    let p = Path::new(path);
    if path.trim().is_empty() {
        return invalid("Choose a directory to scan.".into());
    }
    if !p.exists() {
        return invalid(format!("{path} does not exist."));
    }
    if !p.is_dir() {
        return invalid(format!("{path} is not a directory."));
    }

    let root_is_repo = is_git_repo(p);
    let count = discover_repos(p).len();
    RootValidation {
        ok: count > 0,
        repo_count: count,
        root_is_repo,
        error: (count == 0)
            .then(|| format!("No git repositories in {path}, and it is not a repository itself.")),
    }
}

/* ------------------------------------------------------- git-wt resolution */

#[derive(Debug, Serialize)]
#[serde(untagged, rename_all = "camelCase")]
pub enum GitWtResolution {
    Found {
        ok: bool,
        path: String,
        version: String,
        /// Set when worktrunk is older than [`MIN_GITWT_VERSION`]. Deliberately a warning and
        /// not an error: the adapter tolerates unknown and missing fields, so an older
        /// worktrunk usually still works. Blocking the whole app over a version string would
        /// be worse than telling the user what to expect (spec Q3).
        #[serde(skip_serializing_if = "Option::is_none")]
        warning: Option<String>,
    },
    Missing {
        ok: bool,
        error: String,
    },
}

impl GitWtResolution {
    fn found(path: String, version: String) -> Self {
        let warning = version_warning(&version);
        Self::Found {
            ok: true,
            path,
            version,
            warning,
        }
    }
    fn missing(error: String) -> Self {
        Self::Missing { ok: false, error }
    }
}

/// Extracts a `(major, minor, patch)` triple from a version banner like `wt v0.60.0`.
///
/// Returns `None` when nothing version-shaped is present, in which case we say nothing rather
/// than crying wolf about a binary we simply could not parse.
fn parse_version(banner: &str) -> Option<(u32, u32, u32)> {
    let start = banner.find(|c: char| c.is_ascii_digit())?;
    let rest = &banner[start..];
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(rest.len());
    let mut parts = rest[..end].split('.').map(str::parse::<u32>);
    Some((
        parts.next()?.ok()?,
        parts.next().and_then(Result::ok).unwrap_or(0),
        parts.next().and_then(Result::ok).unwrap_or(0),
    ))
}

fn version_warning(banner: &str) -> Option<String> {
    let found = parse_version(banner)?;
    let minimum = parse_version(MIN_GITWT_VERSION)?;
    (found < minimum).then(|| {
        format!(
            "worktrunk {} is older than the {} this build was written against. \
             The dashboard should still work, but some columns may be missing or wrong.",
            banner.trim(),
            MIN_GITWT_VERSION
        )
    })
}

const BIN: &str = if cfg!(windows) {
    "git-wt.exe"
} else {
    "git-wt"
};

/// Resolves the `git-wt` binary and reads its version.
///
/// GUI processes on macOS and Linux inherit a minimal PATH that usually excludes
/// `~/.cargo/bin` and Homebrew, so PATH alone is not enough — we also probe well-known install
/// directories and, as a last resort, ask a login shell (plan §7 risk table).
pub fn resolve_gitwt(config: &DeckConfig) -> GitWtResolution {
    match locate_gitwt(config) {
        Ok(path) => match probe_version(&path) {
            Ok(version) => GitWtResolution::found(path.to_string_lossy().into_owned(), version),
            Err(e) => GitWtResolution::missing(e.to_string()),
        },
        Err(e) => GitWtResolution::missing(e.to_string()),
    }
}

/// The path every `git-wt` invocation should use. Callers treat the error as fatal-for-this-repo,
/// never as a crash (REQ-15).
pub fn locate_gitwt(config: &DeckConfig) -> DeckResult<PathBuf> {
    // 1. Explicit override — validated before use (NFR-3).
    if let Some(over) = config
        .git_wt_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(over);
        if !p.is_file() {
            return Err(DeckError::GitWtMissing(format!(
                "the configured git-wt path `{over}` is not an existing file"
            )));
        }
        return Ok(p);
    }

    // 2. PATH.
    if let Some(p) = crate::process::which(BIN) {
        return Ok(p);
    }

    // 3. Well-known install locations.
    for dir in common_install_dirs() {
        let candidate = dir.join(BIN);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    // 4. A login shell, which has the user's real PATH.
    if let Some(p) = login_shell_which() {
        return Ok(p);
    }

    Err(DeckError::GitWtMissing(format!(
        "could not find `{BIN}` on PATH or in the usual install directories. \
         Install worktrunk (https://worktrunk.dev), or set the git-wt path in Settings."
    )))
}

fn common_install_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut dirs = Vec::new();

    if let Some(h) = &home {
        dirs.push(h.join(".cargo").join("bin"));
        dirs.push(h.join(".local").join("bin"));
    }

    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            // winget shims land here — this is how worktrunk installs on Windows.
            dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            dirs.push(pf.join("worktrunk"));
        }
    }
    #[cfg(not(windows))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }

    dirs
}

/// Ask the user's login shell where `git-wt` is. Unix only — on Windows the process PATH is
/// already the user PATH, so there is nothing extra to learn.
#[cfg(not(windows))]
fn login_shell_which() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = command(&shell)
        .args(["-lc", "command -v git-wt"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    path.is_file().then_some(path)
}

#[cfg(windows)]
fn login_shell_which() -> Option<PathBuf> {
    None
}

/// Runs `git-wt --version`. This doubles as validation that the resolved file is really the
/// worktrunk CLI and is executable by us.
fn probe_version(path: &Path) -> DeckResult<String> {
    let out = command(path)
        .arg("--version")
        .output()
        .map_err(|e| DeckError::GitWtMissing(format!("cannot execute {}: {e}", path.display())))?;
    if !out.status.success() {
        return Err(DeckError::GitWtMissing(format!(
            "{} --version exited with {}: {}",
            path.display(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let version = raw.trim();
    if version.is_empty() {
        return Err(DeckError::GitWtMissing(format!(
            "{} --version printed nothing — is this really worktrunk?",
            path.display()
        )));
    }
    Ok(version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_repos_dedupes_across_list_and_scan() {
        let cfg = DeckConfig {
            repos: vec![
                "C:/repos/a".into(),
                "C:/repos/a".into(),
                "C:/repos/b".into(),
            ],
            ..Default::default()
        };
        let repos = cfg.effective_repos();
        assert_eq!(repos.len(), 2);
    }

    fn dev(command: &[&str], cwd: Option<&str>) -> DevCommand {
        DevCommand {
            command: command.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.map(str::to_string),
        }
    }

    #[test]
    fn dev_command_lookup_is_separator_insensitive() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "C:/repos/a".to_string(),
            dev(&["pnpm", "dev"], Some("apps/web")),
        );
        let cfg = DeckConfig {
            dev_by_repo: Some(map),
            ..Default::default()
        };
        let found = cfg
            .dev_for(r"C:\repos\a")
            .expect("separator-insensitive lookup");
        assert_eq!(found.cwd.as_deref(), Some("apps/web"));
        assert!(cfg.dev_for("C:/repos/other").is_none());
    }

    #[test]
    fn empty_dev_command_is_treated_as_unset() {
        let mut map = std::collections::HashMap::new();
        map.insert("C:/repos/a".to_string(), dev(&[], None));
        let cfg = DeckConfig {
            dev_by_repo: Some(map),
            ..Default::default()
        };
        assert!(cfg.dev_for("C:/repos/a").is_none());
    }

    #[test]
    fn a_legacy_dev_command_map_is_migrated_on_load() {
        let cfg: DeckConfig = serde_json::from_str(
            r#"{"repos":[],"devCommandByRepo":{"C:/repos/a":["pnpm","dev"]}}"#,
        )
        .unwrap();
        let migrated = cfg.migrate();
        let found = migrated
            .dev_for("C:/repos/a")
            .expect("legacy command survives");
        assert_eq!(found.command, vec!["pnpm".to_string(), "dev".to_string()]);
        assert_eq!(found.cwd, None);
    }

    #[test]
    fn a_new_style_entry_wins_over_the_legacy_one() {
        let cfg: DeckConfig = serde_json::from_str(
            r#"{"repos":[],
                "devCommandByRepo":{"C:/repos/a":["old"]},
                "devByRepo":{"C:/repos/a":{"command":["new"],"cwd":"apps/web"}}}"#,
        )
        .unwrap();
        let found = cfg.migrate().dev_for("C:/repos/a").unwrap();
        assert_eq!(found.command, vec!["new".to_string()]);
    }

    #[test]
    fn dev_cwd_resolves_relative_to_the_worktree() {
        assert_eq!(
            resolve_dev_cwd("C:/repos/demo.feat-x", Some("apps/web")),
            "C:/repos/demo.feat-x/apps/web"
        );
        // Backslash separators and a trailing slash are normalized.
        assert_eq!(
            resolve_dev_cwd("C:/repos/demo.feat-x/", Some("apps\\web\\")),
            "C:/repos/demo.feat-x/apps/web"
        );
        // A *leading* separator is not normalization territory — on Windows `\apps` is the
        // drive root, so it is treated as absolute and refused by the test below.
    }

    #[test]
    fn dev_cwd_falls_back_to_the_worktree_root_when_unset() {
        let root = "C:/repos/demo.feat-x";
        assert_eq!(resolve_dev_cwd(root, None), root);
        assert_eq!(resolve_dev_cwd(root, Some("")), root);
        assert_eq!(resolve_dev_cwd(root, Some("   ")), root);
    }

    /// The settings UI rejects these, but a hand-edited config must not be able to start a dev
    /// server outside the worktree.
    #[test]
    fn dev_cwd_refuses_to_escape_the_worktree() {
        let root = "C:/repos/demo.feat-x";
        for bad in [
            "..",
            "../..",
            "apps/../../elsewhere",
            "/etc",
            "C:/windows",
            r"\apps\web",
            r"\\server\share",
        ] {
            assert_eq!(
                resolve_dev_cwd(root, Some(bad)),
                root,
                "{bad} must be ignored"
            );
        }
    }

    #[test]
    fn hidden_repos_are_dropped_from_the_effective_list() {
        let cfg = DeckConfig {
            repos: vec!["C:/repos/a".into(), "C:/repos/b".into()],
            // Different separators and case must still match on Windows.
            hidden_repos: Some(vec![r"c:\repos\b".into()]),
            ..Default::default()
        };
        let repos = cfg.effective_repos();
        if cfg!(windows) {
            assert_eq!(repos.len(), 1);
            assert!(repos[0].to_string_lossy().contains('a'));
        } else {
            // Case-sensitive elsewhere, so only an exact match hides.
            assert_eq!(repos.len(), 2);
        }
    }

    #[test]
    fn validate_root_rejects_missing_and_non_directories() {
        assert!(!validate_root("").ok);
        assert!(!validate_root("/definitely/not/here/at/all").ok);
    }

    #[test]
    fn validate_root_counts_repos() {
        let tmp = std::env::temp_dir().join("wtdeck-validate-root-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("repo-a").join(".git")).unwrap();
        std::fs::create_dir_all(tmp.join("repo-b").join(".git")).unwrap();
        std::fs::create_dir_all(tmp.join("not-a-repo")).unwrap();

        let v = validate_root(&tmp.to_string_lossy());
        assert!(v.ok);
        assert_eq!(v.repo_count, 2);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Pointing the scan root at a single repo is how you drill into it and hide the rest of
    /// the workspace; scanning its children would find nothing.
    #[test]
    fn a_root_that_is_itself_a_repo_resolves_to_that_repo() {
        let tmp = std::env::temp_dir().join("wtdeck-root-is-repo-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".git")).unwrap();
        // A nested worktree must not be counted as a second repo.
        std::fs::create_dir_all(tmp.join(".claude").join("worktrees").join("feat-x")).unwrap();

        let found = discover_repos(&tmp);
        assert_eq!(found, vec![tmp.clone()]);

        let v = validate_root(&tmp.to_string_lossy());
        assert!(v.ok);
        assert!(v.root_is_repo);
        assert_eq!(v.repo_count, 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_workspace_root_is_not_flagged_as_a_repo() {
        let tmp = std::env::temp_dir().join("wtdeck-workspace-root-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("repo-a").join(".git")).unwrap();

        let v = validate_root(&tmp.to_string_lossy());
        assert!(v.ok);
        assert!(!v.root_is_repo);
        assert_eq!(v.repo_count, 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// worktrunk parks worktrees beside their repo, so a scan root is full of them. Counting
    /// one as a repo duplicates every card in that repo (`.git` file vs `.git` directory).
    #[test]
    fn discovery_skips_linked_worktrees_beside_their_repo() {
        let tmp = std::env::temp_dir().join("wtdeck-linked-worktree-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("demo-app").join(".git")).unwrap();
        std::fs::create_dir_all(tmp.join("demo-app.feat-x")).unwrap();
        std::fs::write(
            tmp.join("demo-app.feat-x").join(".git"),
            "gitdir: ../demo-app/.git/worktrees/feat-x\n",
        )
        .unwrap();

        let found = discover_repos(&tmp);
        assert_eq!(
            found.len(),
            1,
            "only the real checkout is a repo: {found:?}"
        );
        assert!(found[0].ends_with("demo-app"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn config_defaults_are_the_documented_ones() {
        let c = DeckConfig::default();
        assert_eq!(c.version, 1);
        assert_eq!(c.auto_refresh_ms, 5_000);
        assert!(c.confirm_destructive);
        assert!(!c.cross_repo_grouping);
        assert_eq!(c.theme, "system");
    }

    #[test]
    fn partial_config_json_fills_in_defaults() {
        let cfg: DeckConfig = serde_json::from_str(r#"{"repos":["C:/repos/a"]}"#).unwrap();
        assert_eq!(cfg.repos.len(), 1);
        assert!(cfg.confirm_destructive);
        assert_eq!(cfg.auto_refresh_ms, 5_000);
    }

    #[test]
    fn version_banners_are_parsed_from_worktrunks_real_output() {
        // This is exactly what `git-wt --version` prints.
        assert_eq!(parse_version("wt v0.60.0"), Some((0, 60, 0)));
        assert_eq!(parse_version("0.61"), Some((0, 61, 0)));
        assert_eq!(parse_version("git-wt 1.2.3-beta"), Some((1, 2, 3)));
        assert_eq!(parse_version("no version here"), None);
    }

    #[test]
    fn only_versions_below_the_minimum_warn() {
        assert!(version_warning("wt v0.59.9").is_some());
        assert!(version_warning("wt v0.60.0").is_none());
        assert!(version_warning("wt v0.61.0").is_none());
        assert!(version_warning("wt v1.0.0").is_none());
        // An unparseable banner must not produce a spurious warning.
        assert!(version_warning("some custom build").is_none());
    }

    #[test]
    fn override_must_point_at_an_existing_file() {
        let cfg = DeckConfig {
            git_wt_path: Some("/no/such/git-wt".into()),
            ..Default::default()
        };
        assert!(matches!(
            locate_gitwt(&cfg),
            Err(DeckError::GitWtMissing(_))
        ));
    }
}
