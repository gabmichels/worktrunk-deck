//! "Run externally" (REQ-8) and the open-in-editor / open-URL helpers (REQ-6).
//!
//! Some people want their own terminal — their profile, their font, their tmux. This module is
//! best-effort by design: every platform has a different terminal story, so we try the user's
//! configured choice, then a sensible per-OS default, and report a clear failure rather than
//! guessing wildly (plan §5).

use std::path::Path;

use crate::error::{DeckError, DeckResult};
use crate::process::command;

/// Opens the OS terminal in `worktree_path`, running `dev_command` if one is configured.
///
/// `preferred` comes from `config.externalTerminal`; when it is `None` we fall back to the
/// first candidate that exists on this machine.
pub fn run_external(
    worktree_path: &str,
    dev_command: Option<&[String]>,
    preferred: Option<&str>,
) -> DeckResult<()> {
    let dir = Path::new(worktree_path);
    if !dir.is_dir() {
        return Err(DeckError::Io(format!(
            "{worktree_path} is not a directory"
        )));
    }

    let joined = dev_command.map(join_command);

    #[cfg(windows)]
    {
        run_external_windows(worktree_path, joined.as_deref(), preferred)
    }
    #[cfg(target_os = "macos")]
    {
        run_external_macos(worktree_path, joined.as_deref(), preferred)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        run_external_linux(worktree_path, joined.as_deref(), preferred)
    }
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

#[cfg(windows)]
fn run_external_windows(
    cwd: &str,
    dev: Option<&str>,
    preferred: Option<&str>,
) -> DeckResult<()> {
    // Windows Terminal first — it is the modern default and takes an explicit start directory.
    // NOTE: the executable is `wt.exe`. On this project's own author machine `wt` is shadowed
    // by worktrunk's alias in the shell, but we spawn the binary directly, so that does not
    // apply here.
    let candidates: Vec<&str> = match preferred {
        Some(p) if !p.trim().is_empty() => vec![p],
        _ => vec!["wt.exe", "powershell.exe", "cmd.exe"],
    };

    for candidate in candidates {
        let spawned = match candidate {
            "wt.exe" | "wt" => {
                let mut c = command("wt.exe");
                c.args(["-d", cwd]);
                if let Some(dev) = dev {
                    // Keep the pane alive after the dev command exits so errors stay readable.
                    c.args([
                        "powershell.exe",
                        "-NoExit",
                        "-Command",
                        dev,
                    ]);
                }
                c.spawn()
            }
            "cmd.exe" | "cmd" => {
                let mut c = command("cmd.exe");
                match dev {
                    Some(dev) => c.args(["/c", "start", "cmd.exe", "/k", "cd", "/d", cwd, "&&", dev]),
                    None => c.args(["/c", "start", "cmd.exe", "/k", "cd", "/d", cwd]),
                };
                c.spawn()
            }
            other => {
                let mut c = command(other);
                let script = match dev {
                    Some(dev) => format!("Set-Location -LiteralPath '{}'; {dev}", cwd.replace('\'', "''")),
                    None => format!("Set-Location -LiteralPath '{}'", cwd.replace('\'', "''")),
                };
                c.args(["-NoExit", "-Command", &script]);
                c.spawn()
            }
        };
        if spawned.is_ok() {
            return Ok(());
        }
    }

    Err(DeckError::Io(
        "could not launch an external terminal (tried Windows Terminal, PowerShell and cmd). \
         Set a specific terminal in Settings."
            .into(),
    ))
}

#[cfg(target_os = "macos")]
fn run_external_macos(cwd: &str, dev: Option<&str>, preferred: Option<&str>) -> DeckResult<()> {
    // `open -a <App> <dir>` opens the app at that directory but cannot pass a command, so when
    // there is a dev command we drive Terminal/iTerm via AppleScript instead.
    let app = preferred
        .filter(|p| !p.trim().is_empty())
        .unwrap_or("Terminal");

    if let Some(dev) = dev {
        let script = match app {
            "iTerm" | "iTerm2" => format!(
                r#"tell application "iTerm"
                     create window with default profile
                     tell current session of current window to write text "cd {cwd} && {dev}"
                   end tell"#
            ),
            _ => format!(r#"tell application "Terminal" to do script "cd {cwd} && {dev}""#),
        };
        let status = command("osascript").args(["-e", &script]).status()?;
        if status.success() {
            return Ok(());
        }
    }

    let status = command("open").args(["-a", app, cwd]).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(DeckError::Io(format!(
            "could not open {app} at {cwd}. Set a specific terminal in Settings."
        )))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn run_external_linux(cwd: &str, dev: Option<&str>, preferred: Option<&str>) -> DeckResult<()> {
    // There is no standard here. Honour $TERMINAL (which many users set precisely for this),
    // then walk the common emulators.
    let env_terminal = std::env::var("TERMINAL").ok();
    let mut candidates: Vec<String> = Vec::new();
    if let Some(p) = preferred.filter(|p| !p.trim().is_empty()) {
        candidates.push(p.to_string());
    }
    if let Some(t) = env_terminal.filter(|t| !t.trim().is_empty()) {
        candidates.push(t);
    }
    candidates.extend(
        [
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "kitty",
            "alacritty",
            "wezterm",
            "xfce4-terminal",
            "xterm",
        ]
        .iter()
        .map(|s| s.to_string()),
    );

    for candidate in candidates {
        let mut c = command(&candidate);
        // `--working-directory` is GNOME's spelling; most others accept `-e` with a shell that
        // cd's itself, which is why we build the command that way for the generic case.
        let shell_cmd = match dev {
            Some(dev) => format!("cd {cwd:?} && {dev}; exec ${{SHELL:-/bin/sh}}"),
            None => format!("cd {cwd:?}; exec ${{SHELL:-/bin/sh}}"),
        };
        c.args(["-e", "sh", "-c", &shell_cmd]);
        if c.spawn().is_ok() {
            return Ok(());
        }
    }

    Err(DeckError::Io(
        "could not launch an external terminal. Set $TERMINAL, or choose one in Settings.".into(),
    ))
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
    open_in_file_manager(path)
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

fn open_in_file_manager(path: &str) -> DeckResult<()> {
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
