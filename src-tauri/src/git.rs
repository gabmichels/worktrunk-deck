//! Read-only `git log`, for the expanded card's commit history.
//!
//! # Why this exists at all
//!
//! Everywhere else the deck talks only to `git-wt` (see `gitwt.rs`, NFR-3). worktrunk has no
//! log subcommand, so showing history requires calling `git` directly. That is a deliberate,
//! narrow widening of the process surface, and it is confined to this module under three
//! rules:
//!
//! 1. **Read-only subcommands only.** The single entry point runs `git log` and nothing else.
//!    There is no code path here that can write to a repository.
//! 2. **No user-supplied argument strings.** Every flag is a fixed literal. The caller
//!    controls only the working directory and two integers, both of which are validated.
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

/// Reads one page of history for a worktree.
///
/// Returns an empty list for a repository with no commits — a freshly initialised repo is a
/// normal state, not an error the card should shout about.
pub async fn log(worktree: &Path, skip: u32, limit: u32) -> DeckResult<Vec<Commit>> {
    if !worktree.is_dir() {
        return Err(DeckError::Io(format!(
            "{} is not a directory",
            worktree.display()
        )));
    }
    let limit = limit.clamp(1, MAX_LIMIT);

    let format = format!("--format=%H{SEP}%h{SEP}%an{SEP}%at{SEP}%s");
    let output = async_command("git")
        .arg("-C")
        .arg(worktree)
        .arg("log")
        .arg(format)
        .arg(format!("--skip={skip}"))
        .arg(format!("--max-count={limit}"))
        .arg("--no-color")
        // Nothing after this can be read as a flag.
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
