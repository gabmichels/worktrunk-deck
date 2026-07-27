//! Which terminal to open, and how to open it (REQ-8).
//!
//! Naming a terminal used to be free text, which asked the user to know both the executable
//! name *and* the flags it wants for a start directory — and silently did nothing when they
//! guessed wrong. Instead this module keeps a small per-OS catalogue: each entry knows how to
//! be found on disk and how to be launched with a working directory and an optional command.
//! Settings then offers what is actually installed.
//!
//! Two rules keep this honest:
//!
//! 1. **A terminal is only offered if it was found.** Detection is a filesystem probe, never a
//!    guess from the OS name — a Windows machine without Windows Terminal must not be told it
//!    has one.
//! 2. **Free text still works.** Anything not in the catalogue is treated as an executable and
//!    launched in the working directory. The catalogue is a convenience, not an allowlist —
//!    people run terminals nobody has heard of.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{DeckError, DeckResult};
#[cfg(any(target_os = "macos", windows))]
use crate::process::command;
use crate::process::windowed_command;

/// One row of the Settings dropdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChoice {
    /// Stable identifier stored in `config.externalTerminal`.
    pub id: String,
    pub label: String,
    /// Whether it was actually found on this machine. Unavailable entries are still returned so
    /// the UI can explain why a previously-saved choice stopped working.
    pub available: bool,
    /// Where it was found — shown as the subtitle, and useful when two installs disagree.
    pub path: Option<String>,
    /// Whether it can be handed a command to run. Surfaced so Settings can say up front that
    /// "Run dev" will fall back, rather than letting it surprise the user later.
    pub takes_command: bool,
}

/// Every terminal this build knows about on the current OS, in preference order.
pub fn list() -> Vec<TerminalChoice> {
    platform::ENTRIES
        .iter()
        .map(|e| {
            let path = platform::locate(e.id);
            TerminalChoice {
                id: e.id.to_string(),
                label: e.label.to_string(),
                available: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
                takes_command: e.takes_command,
            }
        })
        .collect()
}

/// Opens `cwd` in a terminal, running `dev` in it if given.
///
/// `preferred` is a catalogue id, an executable path, or `None` for "whatever is installed".
///
/// `Ok(Some(note))` means the selected terminal could not be used and another one was. That was
/// previously silent, which reads as a bug: you pick Warp, press "Run dev", and Windows Terminal
/// opens with no explanation.
pub fn run(preferred: Option<&str>, cwd: &str, dev: Option<&str>) -> DeckResult<Option<String>> {
    let preferred = preferred.map(str::trim).filter(|p| !p.is_empty());

    if let Some(id) = preferred {
        if let Some(entry) = platform::ENTRIES.iter().find(|e| e.id == id) {
            let Some(path) = platform::locate(entry.id) else {
                return Err(DeckError::Io(format!(
                    "{} is selected in Settings but was not found on this machine",
                    entry.label
                )));
            };
            // A terminal that cannot be handed a command can still be opened at the directory;
            // falling through to the default would silently ignore the user's choice, so only
            // the *command* falls back, and only when there is one.
            if dev.is_some() && !entry.takes_command {
                let used = first_available(cwd, dev).map_err(|_| {
                    DeckError::Io(format!(
                        "{} cannot be given a command to run, and no other terminal was found",
                        entry.label
                    ))
                })?;
                return Ok(Some(format!(
                    "{} cannot be handed a command to run, so {used} was used instead.",
                    entry.label
                )));
            }
            platform::launch(entry, &path, cwd, dev)?;
            return Ok(None);
        }
        // Not in the catalogue: an executable the user named themselves. Most terminals start
        // in the directory they inherit, which is the one portable thing we can rely on.
        custom(id, cwd)?;
        return Ok(None);
    }

    first_available(cwd, dev)?;
    Ok(None)
}

/// Launches the first installed terminal that can do the job, returning its label.
fn first_available(cwd: &str, dev: Option<&str>) -> DeckResult<String> {
    for entry in platform::ENTRIES {
        if dev.is_some() && !entry.takes_command {
            continue;
        }
        if let Some(path) = platform::locate(entry.id) {
            if platform::launch(entry, &path, cwd, dev).is_ok() {
                return Ok(entry.label.to_string());
            }
        }
    }
    Err(DeckError::Io(
        "could not find a terminal to launch. Choose one in Settings.".into(),
    ))
}

fn custom(exe: &str, cwd: &str) -> DeckResult<()> {
    windowed_command(exe)
        .current_dir(cwd)
        .spawn()
        .map(|_| ())
        .map_err(|e| DeckError::Io(format!("could not launch `{exe}`: {e}")))
}

/// A catalogue entry. `takes_command` is what separates "open a terminal here" from "run the
/// dev server here" — Warp, for one, can do the first and not the second.
pub struct Entry {
    pub id: &'static str,
    pub label: &'static str,
    pub takes_command: bool,
}

const fn entry(id: &'static str, label: &'static str, takes_command: bool) -> Entry {
    Entry {
        id,
        label,
        takes_command,
    }
}

/// Quotes for a POSIX `sh -c` string.
#[cfg(not(windows))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/* ------------------------------------------------------------------- Windows */

#[cfg(windows)]
mod platform {
    use super::*;

    pub const ENTRIES: &[Entry] = &[
        entry("wt", "Windows Terminal", true),
        entry("pwsh", "PowerShell 7", true),
        entry("powershell", "Windows PowerShell", true),
        entry("cmd", "Command Prompt", true),
        entry("git-bash", "Git Bash", true),
        entry("wezterm", "WezTerm", true),
        entry("alacritty", "Alacritty", true),
        // Warp is driven through its URI scheme, which cannot carry a command (warp#5859).
        entry("warp", "Warp", false),
    ];

    pub fn locate(id: &str) -> Option<PathBuf> {
        match id {
            "wt" => which("wt.exe"),
            "pwsh" => which("pwsh.exe"),
            // Always present, but resolve it anyway rather than assuming a path — Windows
            // installs are not all identical, and a resolved path is what we spawn.
            "powershell" => which("powershell.exe").or_else(|| system32("WindowsPowerShell")),
            "cmd" => which("cmd.exe").or_else(|| system32("")),
            "git-bash" => program_files("Git\\git-bash.exe"),
            "wezterm" => which("wezterm-gui.exe").or_else(|| which("wezterm.exe")),
            "alacritty" => which("alacritty.exe"),
            "warp" => program_files("Programs\\Warp\\warp.exe")
                .or_else(|| program_files("Warp\\warp.exe"))
                .or_else(|| which("warp.exe")),
            _ => None,
        }
    }

    fn system32(sub: &str) -> Option<PathBuf> {
        let root = PathBuf::from(std::env::var_os("SystemRoot")?).join("System32");
        let p = match sub {
            "" => root.join("cmd.exe"),
            _ => root.join(sub).join("v1.0").join("powershell.exe"),
        };
        p.is_file().then_some(p)
    }

    fn program_files(rel: &str) -> Option<PathBuf> {
        ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|base| PathBuf::from(base).join(rel))
            .find(|p| p.is_file())
    }

    pub fn launch(entry: &Entry, path: &Path, cwd: &str, dev: Option<&str>) -> DeckResult<()> {
        // Warp has no command-line interface for a start directory; the documented way in is
        // its URI scheme, so it never runs `path` as a program.
        if entry.id == "warp" {
            return open_warp(cwd);
        }

        let mut c = windowed_command(path);
        // Also the fallback for anything that ignores its flags: a terminal that inherits our
        // working directory lands in the right place regardless.
        c.current_dir(cwd);

        match entry.id {
            "wt" => {
                // `-w 0 new-tab` reuses the most recently used window instead of opening a new
                // one — a dev server per worktree otherwise litters the desktop with windows.
                // If none is open, Windows Terminal creates one, so this is safe either way.
                c.args(["-w", "0", "new-tab", "-d", cwd]);
                if let Some(dev) = dev {
                    // -NoExit keeps the pane open after the command exits, so a dev server that
                    // crashes on startup leaves its error on screen instead of vanishing.
                    c.args([&shell_for_command(), "-NoExit", "-Command", dev]);
                }
            }
            "pwsh" | "powershell" => {
                let script = match dev {
                    Some(dev) => format!("Set-Location -LiteralPath '{}'; {dev}", ps_quote(cwd)),
                    None => format!("Set-Location -LiteralPath '{}'", ps_quote(cwd)),
                };
                c.args(["-NoExit", "-Command", &script]);
            }
            "cmd" => match dev {
                Some(dev) => {
                    c.args(["/k", &format!("cd /d \"{cwd}\" && {dev}")]);
                }
                None => {
                    c.args(["/k", &format!("cd /d \"{cwd}\"")]);
                }
            },
            "git-bash" => {
                c.arg(format!("--cd={cwd}"));
                if let Some(dev) = dev {
                    // `exec bash` keeps the window after the command finishes, matching -NoExit.
                    c.args(["-c", &format!("{dev}; exec bash")]);
                }
            }
            "wezterm" => {
                c.args(["start", "--cwd", cwd]);
                if let Some(dev) = dev {
                    c.args(["--", &shell_for_command(), "-NoExit", "-Command", dev]);
                }
            }
            "alacritty" => {
                c.args(["--working-directory", cwd]);
                if let Some(dev) = dev {
                    c.args(["-e", &shell_for_command(), "-NoExit", "-Command", dev]);
                }
            }
            _ => {}
        }

        c.spawn()
            .map(|_| ())
            .map_err(|e| DeckError::Io(format!("could not launch {}: {e}", entry.label)))
    }

    /// PowerShell single-quoted strings escape a quote by doubling it.
    fn ps_quote(s: &str) -> String {
        s.replace('\'', "''")
    }

    /// The PowerShell to run a command in, preferring **7** over Windows PowerShell 5.1.
    ///
    /// They do not share a profile: 7 reads `Documents\PowerShell\`, 5.1 reads
    /// `Documents\WindowsPowerShell\`. Tooling that installs a shell wrapper — worktrunk's
    /// alias integration among it — usually lands in 7 only, so hardcoding `powershell.exe`
    /// silently ran commands in a shell where the user's setup did not exist.
    fn shell_for_command() -> String {
        which("pwsh.exe")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "powershell.exe".to_string())
    }

    /// Opens Warp at `cwd` through `warp://action/new_tab`.
    ///
    /// A tab rather than a window, so opening several worktrees adds tabs to the Warp you
    /// already have open instead of stacking up windows. Warp opens a window if none exists.
    ///
    /// The path must be a `file:///` URL, not a bare Windows path: Warp parses the parameter as
    /// a URL, so `C:\...` is read as a scheme called `c`, the parse fails, and the directory is
    /// silently dropped in favour of the home folder — the same bug Warp's own Explorer
    /// integration has (warp#9844).
    fn open_warp(cwd: &str) -> DeckResult<()> {
        let uri = format!("warp://action/new_tab?path={}", file_url(cwd));
        // `start` is a cmd builtin, so cmd is the launcher — and it must stay invisible, which
        // is why this is `command` and not `windowed_command`. The empty "" is start's title
        // argument; without it a quoted URL would be taken as the window title.
        command("cmd.exe")
            .args(["/c", "start", "", &uri])
            .spawn()
            .map(|_| ())
            .map_err(|e| DeckError::Io(format!("could not open Warp: {e}")))
    }
}

/// A local path as a `file:///` URL, percent-encoding everything outside the unreserved set.
///
/// Deliberately conservative: `?`, `#` and `%` would otherwise be read as URL syntax, and a
/// space silently truncates the parameter.
#[cfg(not(target_os = "macos"))]
fn file_url(path: &str) -> String {
    let mut out = String::from("file:///");
    for byte in path.replace('\\', "/").bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/* --------------------------------------------------------------------- macOS */

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub const ENTRIES: &[Entry] = &[
        entry("terminal", "Terminal", true),
        entry("iterm", "iTerm2", true),
        entry("ghostty", "Ghostty", true),
        entry("wezterm", "WezTerm", true),
        entry("kitty", "kitty", true),
        entry("alacritty", "Alacritty", true),
        // Warp has no scripting interface and no CLI that takes a command.
        entry("warp", "Warp", false),
    ];

    /// The `.app` bundle each id lives in, and the CLI inside it we prefer to drive.
    fn bundle(id: &str) -> Option<(&'static str, Option<&'static str>)> {
        Some(match id {
            "terminal" => ("Terminal", None),
            "iterm" => ("iTerm", None),
            "warp" => ("Warp", None),
            "ghostty" => ("Ghostty", Some("ghostty")),
            "wezterm" => ("WezTerm", Some("wezterm-gui")),
            "kitty" => ("kitty", Some("kitty")),
            "alacritty" => ("Alacritty", Some("alacritty")),
            _ => return None,
        })
    }

    pub fn locate(id: &str) -> Option<PathBuf> {
        let (app, _) = bundle(id)?;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let mut roots = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications/Utilities"),
            PathBuf::from("/Applications/Utilities"),
        ];
        if let Some(h) = home {
            roots.push(h.join("Applications"));
        }
        roots
            .into_iter()
            .map(|r| r.join(format!("{app}.app")))
            .find(|p| p.is_dir())
    }

    /// The command-line binary inside a bundle, when it has one worth driving directly.
    fn cli(id: &str, app_path: &Path) -> Option<PathBuf> {
        let (_, bin) = bundle(id)?;
        let p = app_path.join("Contents/MacOS").join(bin?);
        p.is_file().then_some(p)
    }

    pub fn launch(entry: &Entry, path: &Path, cwd: &str, dev: Option<&str>) -> DeckResult<()> {
        // Terminal and iTerm have no useful CLI; AppleScript is the supported way in.
        if matches!(entry.id, "terminal" | "iterm") {
            if let Some(dev) = dev {
                return applescript(entry.id, cwd, dev);
            }
            return open_app(path, cwd);
        }

        let Some(bin) = cli(entry.id, path) else {
            return open_app(path, cwd);
        };

        let mut c = windowed_command(&bin);
        c.current_dir(cwd);
        match entry.id {
            "ghostty" => {
                c.arg(format!("--working-directory={cwd}"));
                if let Some(dev) = dev {
                    c.args(["-e", "sh", "-c", &keep_open(dev)]);
                }
            }
            "wezterm" => {
                c.args(["start", "--cwd", cwd]);
                if let Some(dev) = dev {
                    c.args(["--", "sh", "-c", &keep_open(dev)]);
                }
            }
            "kitty" => {
                c.args(["--directory", cwd]);
                if let Some(dev) = dev {
                    c.args(["sh", "-c", &keep_open(dev)]);
                }
            }
            "alacritty" => {
                c.args(["--working-directory", cwd]);
                if let Some(dev) = dev {
                    c.args(["-e", "sh", "-c", &keep_open(dev)]);
                }
            }
            _ => {}
        }
        c.spawn()
            .map(|_| ())
            .map_err(|e| DeckError::Io(format!("could not launch {}: {e}", entry.label)))
    }

    fn open_app(app_path: &Path, cwd: &str) -> DeckResult<()> {
        let status = command("open").arg("-a").arg(app_path).arg(cwd).status()?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| DeckError::Io(format!("could not open {} at {cwd}", app_path.display())))
    }

    fn applescript(id: &str, cwd: &str, dev: &str) -> DeckResult<()> {
        let run = format!("cd {} && {dev}", sh_quote(cwd));
        // AppleScript string literals escape with a backslash, so the shell line has to be
        // escaped a second time on its way through osascript.
        let escaped = run.replace('\\', r"\\").replace('"', r#"\""#);
        let script = if id == "iterm" {
            format!(
                r#"tell application "iTerm"
                     create window with default profile
                     tell current session of current window to write text "{escaped}"
                   end tell"#
            )
        } else {
            format!(r#"tell application "Terminal" to do script "{escaped}""#)
        };
        let status = command("osascript").args(["-e", &script]).status()?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| DeckError::Io("the terminal refused the AppleScript".into()))
    }
}

/* --------------------------------------------------------------------- Linux */

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::*;

    pub const ENTRIES: &[Entry] = &[
        entry("gnome-terminal", "GNOME Terminal", true),
        entry("konsole", "Konsole", true),
        entry("ghostty", "Ghostty", true),
        entry("kitty", "kitty", true),
        entry("alacritty", "Alacritty", true),
        entry("wezterm", "WezTerm", true),
        entry("foot", "foot", true),
        entry("tilix", "Tilix", true),
        entry("xfce4-terminal", "Xfce Terminal", true),
        entry("xterm", "xterm", true),
        entry("x-terminal-emulator", "System default", true),
        // Driven through its URI scheme, which cannot carry a command (warp#5859).
        entry("warp", "Warp", false),
    ];

    pub fn locate(id: &str) -> Option<PathBuf> {
        match id {
            "wezterm" => which("wezterm-gui").or_else(|| which("wezterm")),
            "warp" => which("warp-terminal").or_else(|| which("warp")),
            other => which(other),
        }
    }

    pub fn launch(entry: &Entry, path: &Path, cwd: &str, dev: Option<&str>) -> DeckResult<()> {
        // Warp takes no start-directory flag; its URI scheme is the documented way in, and
        // xdg-open hands it to whatever registered the `warp://` handler.
        if entry.id == "warp" {
            return windowed_command("xdg-open")
                .arg(format!("warp://action/new_tab?path={}", file_url(cwd)))
                .spawn()
                .map(|_| ())
                .map_err(|e| DeckError::Io(format!("could not open Warp: {e}")));
        }

        let mut c = windowed_command(path);
        c.current_dir(cwd);
        let shell = dev.map(keep_open);

        match entry.id {
            "gnome-terminal" => {
                c.arg(format!("--working-directory={cwd}"));
                if let Some(s) = &shell {
                    // `--` is required since 3.x; `-e` is deprecated and mangles quoting.
                    c.args(["--", "sh", "-c", s]);
                }
            }
            "konsole" => {
                c.args(["--workdir", cwd]);
                if let Some(s) = &shell {
                    c.args(["-e", "sh", "-c", s]);
                }
            }
            "ghostty" | "foot" => {
                c.arg(format!("--working-directory={cwd}"));
                if let Some(s) = &shell {
                    if entry.id == "ghostty" {
                        c.arg("-e");
                    }
                    c.args(["sh", "-c", s]);
                }
            }
            "kitty" => {
                c.args(["--directory", cwd]);
                if let Some(s) = &shell {
                    c.args(["sh", "-c", s]);
                }
            }
            "alacritty" => {
                c.args(["--working-directory", cwd]);
                if let Some(s) = &shell {
                    c.args(["-e", "sh", "-c", s]);
                }
            }
            "wezterm" => {
                c.args(["start", "--cwd", cwd]);
                if let Some(s) = &shell {
                    c.args(["--", "sh", "-c", s]);
                }
            }
            "tilix" => {
                c.args(["-w", cwd]);
                if let Some(s) = &shell {
                    c.args(["-e", "sh", "-c", s]);
                }
            }
            // xterm and the Debian alternatives symlink take neither a working-directory flag
            // nor a reliable long option, so the cd happens inside the shell instead.
            _ => {
                let inner = match &shell {
                    Some(s) => format!("cd {} && {s}", sh_quote(cwd)),
                    None => format!("cd {}; exec ${{SHELL:-/bin/sh}}", sh_quote(cwd)),
                };
                c.args(["-e", "sh", "-c", &inner]);
            }
        }

        c.spawn()
            .map(|_| ())
            .map_err(|e| DeckError::Io(format!("could not launch {}: {e}", entry.label)))
    }
}

/// Keeps the window alive after the command exits, so a dev server that dies on startup leaves
/// its error visible rather than closing the terminal on the user.
#[cfg(not(windows))]
fn keep_open(dev: &str) -> String {
    format!("{dev}; exec ${{SHELL:-/bin/sh}}")
}

/// Finds an executable on PATH. Shared with the platform modules above.
#[allow(dead_code)]
fn which(bin: &str) -> Option<PathBuf> {
    crate::process::which(bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_has_a_distinct_id() {
        let mut ids: Vec<&str> = platform::ENTRIES.iter().map(|e| e.id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate terminal id in the catalogue");
    }

    #[test]
    fn the_catalogue_reports_availability_for_every_entry() {
        let listed = list();
        assert_eq!(listed.len(), platform::ENTRIES.len());
        // An entry claiming to be available must say where it was found, or the UI would show
        // a checkmark with nothing behind it.
        for choice in listed {
            assert_eq!(choice.available, choice.path.is_some(), "{}", choice.id);
        }
    }

    /// Every developer machine has *some* terminal; a catalogue that finds none on the host it
    /// was written for is a detection bug, not an empty machine.
    #[test]
    fn at_least_one_terminal_is_found_on_this_machine() {
        assert!(
            list().iter().any(|t| t.available),
            "no terminal detected — check the probes for this platform"
        );
    }

    #[test]
    fn an_unknown_id_is_rejected_rather_than_silently_ignored() {
        let err = run(
            Some("definitely-not-a-terminal"),
            env!("CARGO_MANIFEST_DIR"),
            None,
        );
        assert!(err.is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_always_finds_powershell_and_cmd() {
        let listed = list();
        for id in ["powershell", "cmd"] {
            let found = listed.iter().find(|t| t.id == id).expect("in catalogue");
            assert!(found.available, "{id} must always resolve on Windows");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn a_command_is_kept_visible_after_it_exits() {
        assert!(keep_open("pnpm dev").starts_with("pnpm dev;"));
        assert!(keep_open("pnpm dev").contains("exec"));
    }

    #[cfg(not(windows))]
    #[test]
    fn quoting_survives_a_path_with_a_quote_in_it() {
        assert_eq!(sh_quote("/tmp/it's here"), r"'/tmp/it'\''s here'");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_path_becomes_a_file_url() {
        // A bare `C:\...` is what Warp's own Explorer integration sends, and what it then
        // silently drops — so the drive letter has to survive as part of the *path*.
        assert_eq!(file_url(r"C:\Workspace\deck"), "file:///C:/Workspace/deck");
    }

    #[cfg(windows)]
    #[test]
    fn characters_that_would_be_read_as_url_syntax_are_escaped() {
        assert_eq!(
            file_url(r"C:\my repo\a#b?c"),
            "file:///C:/my%20repo/a%23b%3Fc"
        );
        // Non-ASCII must survive as UTF-8 bytes rather than being dropped.
        assert_eq!(file_url(r"C:\ü"), "file:///C:/%C3%BC");
    }
}
