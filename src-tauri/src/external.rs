//! "Run externally" (REQ-8) and the open-in-editor / open-URL helpers (REQ-6).
//!
//! Some people want their own terminal — their profile, their font, their tmux. Which terminals
//! exist and how each is launched lives in [`crate::terminals`]; what remains here is the
//! editor, file-manager and URL openers, which are one command per platform and need no
//! catalogue.

use std::path::Path;

use crate::error::{DeckError, DeckResult};
use crate::process::command;

/// Opens the OS terminal in `worktree_path`, running `dev_command` if one is configured.
///
/// `preferred` comes from `config.externalTerminal`; when it is `None` we fall back to the
/// first candidate that exists on this machine. Which terminals exist and how each one is
/// launched lives in `terminals.rs` — this function's job is only to validate the directory
/// and flatten the dev command into a single shell line.
pub fn run_external(
    worktree_path: &str,
    dev_command: Option<&[String]>,
    preferred: Option<&str>,
) -> DeckResult<()> {
    let dir = Path::new(worktree_path);
    if !dir.is_dir() {
        return Err(DeckError::Io(format!("{worktree_path} is not a directory")));
    }

    let joined = dev_command.map(join_command);
    crate::terminals::run(preferred, worktree_path, joined.as_deref())
}

/// Quotes each argument so a dev command with spaces survives the trip through a shell.
fn join_command(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            if a.contains(' ') || a.contains('"') {
                format!("\"{}\"", a.replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Opens a folder in the user's editor: Cursor, then VS Code, then the OS file manager
/// (plan §5). Editors are launched detached — we do not wait for them.
pub fn open_in_editor(path: &str) -> DeckResult<()> {
    let dir = Path::new(path);
    if !dir.exists() {
        return Err(DeckError::Io(format!("{path} no longer exists")));
    }

    for editor in editor_candidates() {
        if command(&editor).arg(path).spawn().is_ok() {
            return Ok(());
        }
    }
    spawn_file_manager(path)
}

fn editor_candidates() -> Vec<String> {
    let exe = |name: &str| {
        if cfg!(windows) {
            // The `code`/`cursor` entries on Windows are .cmd shims, which CreateProcess will
            // not run directly.
            format!("{name}.cmd")
        } else {
            name.to_string()
        }
    };
    vec![exe("cursor"), exe("code")]
}

/// Reveals a directory in the OS file manager — Explorer, Finder, or the XDG default.
pub fn open_in_file_manager(path: &str) -> DeckResult<()> {
    if !Path::new(path).exists() {
        return Err(DeckError::Io(format!("{path} no longer exists")));
    }
    spawn_file_manager(path)
}

fn spawn_file_manager(path: &str) -> DeckResult<()> {
    #[cfg(windows)]
    let result = command("explorer.exe").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = command("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = command("xdg-open").arg(path).spawn();

    result
        .map(|_| ())
        .map_err(|e| DeckError::Io(format!("could not open {path}: {e}")))
}

/// Whether a URL is safe to hand to the OS opener. Schemes are case-insensitive per RFC 3986.
fn is_openable_url(url: &str) -> bool {
    let lowered = url.trim().to_ascii_lowercase();
    lowered.starts_with("http://") || lowered.starts_with("https://")
}

/// Opens a dev-server URL in the default browser.
///
/// Restricted to http/https (NFR-3): the URL originates from worktrunk rather than the user,
/// but "hand a string to the OS opener" is exactly the shape of bug that turns into arbitrary
/// scheme execution, so it is validated here regardless.
pub fn open_url(url: &str) -> DeckResult<()> {
    if !is_openable_url(url) {
        return Err(DeckError::Io(format!(
            "refusing to open `{url}` — only http and https URLs are allowed"
        )));
    }

    #[cfg(windows)]
    let result = command("cmd.exe").args(["/c", "start", "", url]).spawn();
    #[cfg(target_os = "macos")]
    let result = command("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = command("xdg-open").arg(url).spawn();

    result
        .map(|_| ())
        .map_err(|e| DeckError::Io(format!("could not open {url}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_http_urls_are_refused() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com",
            "",
        ] {
            assert!(open_url(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn only_http_schemes_are_openable() {
        assert!(is_openable_url("http://localhost:12107"));
        assert!(is_openable_url("https://localhost:12107"));
        assert!(is_openable_url("  http://localhost:12107  "));
        // Schemes are case-insensitive, so a mixed-case scheme must not slip past the check
        // in either direction.
        assert!(is_openable_url("HTTP://localhost:12107"));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("JavaScript:alert(1)"));
        assert!(!is_openable_url("localhost:12107"));
    }

    #[test]
    fn command_joining_quotes_arguments_with_spaces() {
        let argv = vec![
            "pnpm".to_string(),
            "run".to_string(),
            "dev server".to_string(),
        ];
        assert_eq!(join_command(&argv), r#"pnpm run "dev server""#);
    }

    #[test]
    fn command_joining_leaves_simple_arguments_alone() {
        let argv = vec!["pnpm".to_string(), "dev".to_string()];
        assert_eq!(join_command(&argv), "pnpm dev");
    }

    #[test]
    fn run_external_rejects_a_path_that_is_not_a_directory() {
        assert!(run_external("/definitely/not/a/dir/anywhere", None, None).is_err());
    }
}
