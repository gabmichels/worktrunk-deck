//! Read-only git: commit history for the expanded card, and working-tree status for the detail
//! modal.
//!
//! # Why this exists at all
//!
//! Everywhere else the deck talks only to `git-wt` (see `gitwt.rs`, NFR-3). worktrunk reports
//! *that* a worktree is dirty but not which files, and has no log subcommand at all, so both
//! views require calling `git` directly. That is a deliberate, narrow widening of the process
//! surface, and it is confined to this module under three rules:
//!
//! 1. **Read-only subcommands only** — `log` and `status`, plus `rev-parse` and `symbolic-ref`
//!    to work out which branch to compare against. All four only read; there is no code path
//!    here that can write to a repository, and adding one would belong in a different module.
//! 2. **No user-supplied argument strings.** Every flag is a fixed literal, and the one
//!    computed argument — the `<base>..HEAD` range — is built from ref names git itself
//!    reported, never from anything the frontend sent.
//! 3. **`--` terminates the argument list**, so a path that begins with `-` can never be
//!    reinterpreted as a flag.
//!
//! If a future feature needs more git, it belongs here, behind the same rules.

use std::path::Path;

use serde::Serialize;

use crate::error::{DeckError, DeckResult};
use crate::process::async_command;

/// Upper bound on a single page. Guards against a caller asking for the entire history of a
/// large repository and stalling the UI thread that awaits it.
const MAX_LIMIT: u32 = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub short_sha: String,
    pub sha: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
}

/// Field separator for `--format`. A unit separator cannot appear in a commit subject, unlike
/// any printable character we might otherwise pick.
const SEP: &str = "\u{1f}";

/// Runs a read-only git command and returns trimmed stdout, or `None` if it failed.
///
/// Used for the small interrogations that pick a comparison base. A failure here is never
/// interesting on its own — every caller has a sensible fallback — so the error is discarded
/// rather than propagated.
async fn capture(worktree: &Path, args: &[&str]) -> Option<String> {
    let output = async_command("git")
        .arg("-C")
        .arg(worktree)
        .args(args)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The branch this worktree has checked out, or `None` when HEAD is detached.
async fn current_branch(worktree: &Path) -> Option<String> {
    let branch = capture(worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    (branch != "HEAD").then_some(branch)
}

/// The repository's default branch: its name, and the best ref to compare against.
///
/// Prefers a local ref over the remote-tracking one — `origin/main` can be stale, which would
/// make a branch look like it contains commits that are already merged.
async fn default_base(worktree: &Path) -> Option<(String, String)> {
    // `origin/HEAD` is the authoritative answer when it exists; it survives repos whose default
    // is neither main nor master.
    let name = match capture(
        worktree,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .await
    {
        Some(sym) => sym.rsplit('/').next()?.to_string(),
        None => {
            let mut found = None;
            for candidate in ["main", "master"] {
                let reference = format!("refs/heads/{candidate}");
                if capture(worktree, &["rev-parse", "--verify", "--quiet", &reference])
                    .await
                    .is_some()
                {
                    found = Some(candidate.to_string());
                    break;
                }
            }
            found?
        }
    };

    let local = format!("refs/heads/{name}");
    let reference = if capture(worktree, &["rev-parse", "--verify", "--quiet", &local])
        .await
        .is_some()
    {
        name.clone()
    } else {
        format!("origin/{name}")
    };
    Some((reference, name))
}

/// Reads one page of history for a worktree.
///
/// Scoped to **this branch's own commits** — `<default>..HEAD` — rather than the whole history.
/// A feature worktree's card should answer "what did I do here?", and burying two commits of
/// actual work under the repo's entire past does not. The main worktree is the exception: it has
/// no upstream to subtract, so it shows everything, which is also where the shared history
/// belongs.
///
/// Returns an empty list for a branch with no commits of its own, and for a repository with no
/// commits at all — both are ordinary states, not errors to shout about.
pub async fn log(worktree: &Path, skip: u32, limit: u32) -> DeckResult<Vec<Commit>> {
    if !worktree.is_dir() {
        return Err(DeckError::Io(format!(
            "{} is not a directory",
            worktree.display()
        )));
    }
    let limit = limit.clamp(1, MAX_LIMIT);

    // Only narrow when we are confidently on a branch that is not the default one. Detached
    // HEAD, an unknown default, or being on the default branch all fall back to a full log.
    let range = match (current_branch(worktree).await, default_base(worktree).await) {
        (Some(current), Some((base_ref, base_name))) if current != base_name => {
            Some(format!("{base_ref}..HEAD"))
        }
        _ => None,
    };

    let format = format!("--format=%H{SEP}%h{SEP}%an{SEP}%at{SEP}%s");
    let mut command = async_command("git");
    command
        .arg("-C")
        .arg(worktree)
        .arg("log")
        .arg(format)
        .arg(format!("--skip={skip}"))
        .arg(format!("--max-count={limit}"))
        .arg("--no-color");
    if let Some(range) = range {
        command.arg(range);
    }
    // Nothing after this can be read as a flag.
    let output = command
        .arg("--")
        .output()
        .await
        .map_err(|e| DeckError::Io(format!("cannot run git: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        // A repo with no commits yet reports this; it is not a failure worth surfacing.
        if trimmed.contains("does not have any commits yet")
            || trimmed.contains("unknown revision or path not in the working tree")
        {
            return Ok(Vec::new());
        }
        return Err(DeckError::Io(format!("git log failed: {trimmed}")));
    }

    Ok(parse_log(&String::from_utf8_lossy(&output.stdout)))
}

/// One changed path, as git's porcelain format reports it.
///
/// `index` and `worktree` are git's own two status letters, passed through rather than
/// interpreted: a file can be staged *and* have further unstaged edits (`MM`), and collapsing
/// that here would lose the distinction the detail view exists to show. Naming them lives in
/// the frontend, alongside the rest of the presentation logic.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    /// Set only for renames and copies — the path it came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    /// Staged (index) state: `M`, `A`, `D`, `R`, `C`, `?`, or a space for unchanged.
    pub index: String,
    /// Unstaged (working tree) state, same alphabet.
    pub worktree: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    pub entries: Vec<StatusEntry>,
    /// True when the list was cut off — a repo mid-rebase can report tens of thousands.
    pub truncated: bool,
}

/// Above this, the list stops being something a human reads and starts being something that
/// janks the UI thread parsing it.
const MAX_STATUS_ENTRIES: usize = 500;

/// The working tree's changed paths, for the card's status detail view.
///
/// Untracked *directories* are reported collapsed (`.config/` rather than every file inside),
/// which is git's default and matches the flags worktrunk reports. Expanding them would mean
/// walking into `node_modules`.
pub async fn status(worktree: &Path) -> DeckResult<WorkingTreeStatus> {
    if !worktree.is_dir() {
        return Err(DeckError::Io(format!(
            "{} is not a directory",
            worktree.display()
        )));
    }

    let output = async_command("git")
        .arg("-C")
        .arg(worktree)
        .arg("status")
        .arg("--porcelain=v1")
        // NUL-separated, so paths with spaces, quotes or non-ASCII arrive intact instead of
        // being shell-quoted by git and needing to be unquoted here.
        .arg("-z")
        .arg("--")
        .output()
        .await
        .map_err(|e| DeckError::Io(format!("cannot run git: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(DeckError::Io(format!(
            "git status failed: {}",
            stderr.trim()
        )));
    }

    Ok(parse_status(&String::from_utf8_lossy(&output.stdout)))
}

/// Parses `git status --porcelain=v1 -z`.
///
/// Records are NUL-terminated `XY <path>`; a rename or copy is followed by a second record
/// holding the original path, which is why this cannot be a plain `split` and `map`.
fn parse_status(stdout: &str) -> WorkingTreeStatus {
    let mut fields = stdout.split('\0').filter(|f| !f.is_empty());
    let mut entries = Vec::new();
    let mut truncated = false;

    while let Some(field) = fields.next() {
        // "XY path" — two status letters, a space, then at least one character of path.
        if field.len() < 4 {
            continue;
        }
        let mut chars = field.chars();
        let index = chars.next().unwrap_or(' ');
        let worktree = chars.next().unwrap_or(' ');
        let path = field[3..].to_string();

        let original_path = if index == 'R' || index == 'C' || worktree == 'R' || worktree == 'C' {
            fields.next().map(str::to_string)
        } else {
            None
        };

        if entries.len() >= MAX_STATUS_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(StatusEntry {
            path,
            original_path,
            index: index.to_string(),
            worktree: worktree.to_string(),
        });
    }

    WorkingTreeStatus { entries, truncated }
}

/// Parses the `--format` output above. Tolerant by design: a row we cannot read is skipped
/// rather than failing the whole page, matching the adapter's posture on worktrunk JSON.
fn parse_log(stdout: &str) -> Vec<Commit> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            // `splitn(5)` so a subject containing the separator stays intact in the last field.
            let mut parts = line.splitn(5, SEP);
            let sha = parts.next()?.trim().to_string();
            let short_sha = parts.next()?.trim().to_string();
            let author = parts.next()?.trim().to_string();
            let timestamp = parts.next()?.trim().parse::<i64>().ok()?;
            let message = parts.next().unwrap_or("").trim().to_string();
            if sha.is_empty() || short_sha.is_empty() {
                return None;
            }
            Some(Commit {
                sha,
                short_sha,
                author,
                timestamp,
                message,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(sha: &str, short: &str, author: &str, ts: &str, subject: &str) -> String {
        format!("{sha}{SEP}{short}{SEP}{author}{SEP}{ts}{SEP}{subject}")
    }

    #[test]
    fn parses_a_normal_page() {
        let stdout = [
            line(
                "aaa111",
                "aaa111",
                "Ada Lovelace",
                "1782553568",
                "feat: add the thing",
            ),
            line(
                "bbb222",
                "bbb222",
                "Alan Turing",
                "1782553000",
                "fix: undo the thing",
            ),
        ]
        .join("\n");

        let commits = parse_log(&stdout);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].short_sha, "aaa111");
        assert_eq!(commits[0].author, "Ada Lovelace");
        assert_eq!(commits[0].timestamp, 1_782_553_568);
        assert_eq!(commits[0].message, "feat: add the thing");
    }

    #[test]
    fn a_subject_containing_the_separator_survives_intact() {
        let subject = format!("chore: weird{SEP}subject");
        let stdout = line("aaa", "aaa", "Someone", "1", &subject);
        let commits = parse_log(&stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].message, subject);
    }

    #[test]
    fn unparseable_rows_are_skipped_not_fatal() {
        let stdout = [
            "garbage with no separators".to_string(),
            line("aaa", "aaa", "Someone", "not-a-number", "bad timestamp"),
            line("bbb", "bbb", "Someone", "42", "good row"),
            String::new(),
        ]
        .join("\n");

        let commits = parse_log(&stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].message, "good row");
    }

    #[test]
    fn empty_output_is_an_empty_page() {
        assert!(parse_log("").is_empty());
        assert!(parse_log("\n  \n").is_empty());
    }

    #[tokio::test]
    async fn a_non_directory_is_rejected_before_spawning_git() {
        assert!(log(Path::new("/not/a/real/worktree"), 0, 10).await.is_err());
    }

    fn nul(fields: &[&str]) -> String {
        format!("{}\0", fields.join("\0"))
    }

    #[test]
    fn parses_the_common_status_codes() {
        let raw = nul(&[
            "M  staged.txt",
            " M edited.txt",
            "?? new.txt",
            "D  gone.txt",
        ]);
        let status = parse_status(&raw);

        assert!(!status.truncated);
        let paths: Vec<_> = status.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["staged.txt", "edited.txt", "new.txt", "gone.txt"]
        );

        assert_eq!(status.entries[0].index, "M");
        assert_eq!(status.entries[0].worktree, " ");
        assert_eq!(status.entries[1].index, " ");
        assert_eq!(status.entries[1].worktree, "M");
        assert_eq!(status.entries[2].index, "?");
        assert_eq!(status.entries[2].worktree, "?");
    }

    /// `MM` — staged, then edited again. Collapsing the two letters would lose that.
    #[test]
    fn keeps_staged_and_unstaged_state_separate() {
        let status = parse_status(&nul(&["MM both.txt"]));
        assert_eq!(status.entries[0].index, "M");
        assert_eq!(status.entries[0].worktree, "M");
    }

    /// A rename spends two NUL-separated fields; misreading that shifts every later entry.
    #[test]
    fn a_rename_consumes_its_original_path() {
        let status = parse_status(&nul(&["R  now.txt", "before.txt", " M after.txt"]));
        assert_eq!(status.entries.len(), 2);
        assert_eq!(status.entries[0].path, "now.txt");
        assert_eq!(
            status.entries[0].original_path.as_deref(),
            Some("before.txt")
        );
        assert_eq!(status.entries[1].path, "after.txt");
        assert_eq!(status.entries[1].original_path, None);
    }

    /// The reason for `-z`: git would otherwise quote these and we would have to unquote them.
    #[test]
    fn paths_with_spaces_and_non_ascii_survive() {
        let status = parse_status(&nul(&["?? some dir/a file.txt", " M ümlaut.txt"]));
        assert_eq!(status.entries[0].path, "some dir/a file.txt");
        assert_eq!(status.entries[1].path, "ümlaut.txt");
    }

    #[test]
    fn an_empty_status_is_a_clean_tree() {
        let status = parse_status("");
        assert!(status.entries.is_empty());
        assert!(!status.truncated);
    }

    #[test]
    fn a_huge_status_is_capped_and_flagged() {
        let fields: Vec<String> = (0..MAX_STATUS_ENTRIES + 50)
            .map(|i| format!(" M file{i}.txt"))
            .collect();
        let raw = nul(&fields.iter().map(String::as_str).collect::<Vec<_>>());

        let status = parse_status(&raw);
        assert_eq!(status.entries.len(), MAX_STATUS_ENTRIES);
        assert!(
            status.truncated,
            "the UI must be able to say the list was cut"
        );
    }

    /// End to end against real git, so the flags and `-z` handling are not just assumed.
    #[tokio::test]
    async fn reads_a_real_working_tree() {
        let Some(dir) = scratch_repo("wtdeck-git-status-real") else {
            return;
        };
        std::fs::write(dir.join("a.txt"), "edited").expect("edit a tracked file");
        std::fs::write(dir.join("brand-new.txt"), "hello").expect("add an untracked file");

        let status = status(&dir).await.expect("status");
        let by_path = |p: &str| {
            status
                .entries
                .iter()
                .find(|e| e.path == p)
                .unwrap_or_else(|| panic!("expected {p} in {:?}", status.entries))
                .clone()
        };

        assert_eq!(by_path("a.txt").worktree, "M");
        let untracked = by_path("brand-new.txt");
        assert_eq!(
            (untracked.index.as_str(), untracked.worktree.as_str()),
            ("?", "?")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Builds a throwaway repo: two commits on the default branch, then a branch with one of
    /// its own. Returns the repo root, or `None` if git is unusable here.
    fn scratch_repo(name: &str) -> Option<std::path::PathBuf> {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;

        let git = |args: &[&str]| -> bool {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        let commit = |file: &str, message: &str| -> bool {
            std::fs::write(dir.join(file), message).is_ok()
                && git(&["add", "-A"])
                && git(&["commit", "-m", message])
        };

        if !git(&["init", "-b", "main"]) {
            return None;
        }
        // Local identity, so the test does not depend on global git config.
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);

        if !commit("a.txt", "base one") || !commit("b.txt", "base two") {
            return None;
        }
        if !git(&["checkout", "-b", "feat/scoped"]) || !commit("c.txt", "branch only") {
            return None;
        }
        Some(dir)
    }

    /// The card should answer "what did I do on this branch?", not replay the repo's history.
    #[tokio::test]
    async fn a_branch_shows_only_its_own_commits() {
        let Some(dir) = scratch_repo("wtdeck-git-scope-branch") else {
            return; // git unavailable; nothing to assert
        };

        let page = log(&dir, 0, 50).await.expect("log on a branch");
        let messages: Vec<_> = page.iter().map(|c| c.message.as_str()).collect();
        assert_eq!(
            messages,
            vec!["branch only"],
            "expected only the branch's own commit, got {messages:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The default branch has nothing to subtract, so it keeps the full history — which is where
    /// the shared commits should appear.
    #[tokio::test]
    async fn the_default_branch_shows_everything() {
        let Some(dir) = scratch_repo("wtdeck-git-scope-main") else {
            return;
        };
        std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["checkout", "main"])
            .output()
            .expect("checkout main");

        let page = log(&dir, 0, 50).await.expect("log on main");
        let messages: Vec<_> = page.iter().map(|c| c.message.as_str()).collect();
        assert_eq!(messages, vec!["base two", "base one"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A worktree branched but not yet committed to is the empty case the UI words as
    /// "no commits on this branch yet" — it must not fall back to the whole history.
    #[tokio::test]
    async fn a_fresh_branch_has_no_commits_of_its_own() {
        let Some(dir) = scratch_repo("wtdeck-git-scope-fresh") else {
            return;
        };
        std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["checkout", "-b", "feat/untouched", "main"])
            .output()
            .expect("branch from main");

        let page = log(&dir, 0, 50).await.expect("log on a fresh branch");
        assert!(page.is_empty(), "expected no commits, got {page:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The deck runs in its own repository during development, so this exercises the real
    /// binary end to end — including that `--` and the format string survive quoting.
    #[tokio::test]
    async fn reads_real_history_from_this_repository() {
        let here = std::env::current_dir().expect("cwd");
        let repo = here.parent().unwrap_or(&here);

        let Ok(page) = log(repo, 0, 3).await else {
            // Not a git checkout (e.g. a packaged source tarball) — nothing to assert.
            return;
        };
        if page.is_empty() {
            return;
        }
        assert!(page.len() <= 3);
        for c in &page {
            assert!(!c.sha.is_empty());
            assert!(c.sha.starts_with(&c.short_sha));
            assert!(c.timestamp > 0);
        }

        // Paging must not repeat the first commit.
        if let Ok(second) = log(repo, 1, 1).await {
            if let (Some(first), Some(next)) = (page.first(), second.first()) {
                assert_ne!(first.sha, next.sha, "skip= must advance the page");
            }
        }
    }
}
