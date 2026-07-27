//! Interactive PTY sessions (REQ-7) — the app's differentiator.
//!
//! This is a **real pseudo-terminal**, not a stdout tee. That distinction is the whole point:
//! a dev server needs a TTY to emit colour and to receive Ctrl-C, and the user needs to type
//! into the same shell they are watching. `portable-pty` gives us ConPTY on Windows and
//! `openpty` elsewhere behind one API (plan §2, NFR-1).
//!
//! Note this module is deliberately **not** subject to the `git-wt` allowlist in `gitwt.rs`.
//! That allowlist exists so the *UI* cannot spawn arbitrary processes; a terminal the user
//! explicitly opened, rooted in a worktree directory, is the one sanctioned exception
//! (NFR-3). It is still never driven by remote or untrusted input.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{DeckError, DeckResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputEvent {
    pub session_id: String,
    /// Base64 because PTY output is a **byte** stream: a chunk boundary can fall inside a
    /// multi-byte character, and lossy UTF-8 conversion here would corrupt it permanently.
    /// The frontend decodes to bytes and hands them straight to xterm.js.
    pub base64_bytes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitEvent {
    pub session_id: String,
    pub code: Option<i32>,
}

/// Where PTY events go.
///
/// Exists so the session machinery can be exercised without a running Tauri app: the real
/// implementation forwards to the webview, the test one to a channel. Spawning a shell and
/// reading its output back is the only way to actually prove ConPTY works, and that check is
/// worth far more than a mock (REQ-7, TASK-13).
pub trait PtyEmitter: Send + Sync + 'static {
    fn output(&self, session_id: &str, base64_bytes: String);
    fn exit(&self, session_id: &str, code: Option<i32>);
}

impl PtyEmitter for AppHandle {
    fn output(&self, session_id: &str, base64_bytes: String) {
        let _ = self.emit(
            "pty-output",
            PtyOutputEvent {
                session_id: session_id.to_string(),
                base64_bytes,
            },
        );
    }

    fn exit(&self, session_id: &str, code: Option<i32>) {
        let _ = self.emit(
            "pty-exit",
            PtyExitEvent {
                session_id: session_id.to_string(),
                code,
            },
        );
    }
}

struct Session {
    /// Writes user keystrokes into the PTY.
    writer: Box<dyn Write + Send>,
    /// Resizes the PTY; the child learns the new size via SIGWINCH (or the ConPTY equivalent).
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Session>>,
    next_id: AtomicU64,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn new_id(&self) -> String {
        format!("pty-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

/// Opens a PTY rooted in `cwd`, running `cmd` (or the user's default shell when `None`).
///
/// Returns the session id immediately; output arrives asynchronously as `pty-output` events
/// and the session ends with `pty-exit`.
pub fn open(
    app: &AppHandle,
    registry: &Arc<PtyRegistry>,
    cwd: &str,
    cmd: Option<Vec<String>>,
) -> DeckResult<String> {
    open_with_emitter(Arc::new(app.clone()), registry, cwd, cmd)
}

/// The real implementation, generic over where events go. See [`PtyEmitter`].
pub fn open_with_emitter(
    emitter: Arc<dyn PtyEmitter>,
    registry: &Arc<PtyRegistry>,
    cwd: &str,
    cmd: Option<Vec<String>>,
) -> DeckResult<String> {
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return Err(DeckError::Pty(format!(
            "cannot open a terminal in `{cwd}` — it is not a directory"
        )));
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| DeckError::Pty(format!("could not allocate a pseudo-terminal: {e}")))?;

    let mut builder = match cmd {
        Some(argv) if !argv.is_empty() => {
            let mut b = CommandBuilder::new(&argv[0]);
            for a in &argv[1..] {
                b.arg(a);
            }
            b
        }
        _ => CommandBuilder::new(default_shell()),
    };
    builder.cwd(dir);

    // Inherit the parent environment **explicitly**. `CommandBuilder` does not reliably pass
    // the ambient environment through once any `env()` call is made, and a shell launched
    // without PATH/SystemRoot either dies immediately or hangs having drawn nothing — which
    // looks exactly like a broken PTY.
    for (key, value) in std::env::vars_os() {
        builder.env(key, value);
    }

    // Tell the child it is on a capable terminal so it emits colour. Without this, many tools
    // detect a dumb terminal and strip formatting, which defeats the point of a real PTY.
    builder.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| DeckError::Pty(format!("could not start the terminal in `{cwd}`: {e}")))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| DeckError::Pty(format!("could not attach to the terminal: {e}")))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| DeckError::Pty(format!("could not read from the terminal: {e}")))?;

    let id = registry.new_id();

    registry
        .sessions
        .lock()
        .expect("pty registry poisoned")
        .insert(
            id.clone(),
            Session {
                writer,
                master: pair.master,
                child,
            },
        );

    // The PTY reader is a blocking API, so it gets a real OS thread rather than a tokio task —
    // parking a runtime worker on a read that only ends when the shell exits would starve the
    // async pool that `list_worktrees` depends on.
    {
        let registry = Arc::clone(registry);
        let id = id.clone();
        std::thread::spawn(move || {
            let engine = base64::engine::general_purpose::STANDARD;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => emitter.output(&id, engine.encode(&buf[..n])),
                    Err(_) => break,
                }
            }

            // Reap the child so the exit code is real rather than a guess, then drop the
            // session — a closed PTY must not linger in the registry (REQ-7).
            let code = {
                let mut sessions = registry.sessions.lock().expect("pty registry poisoned");
                sessions
                    .remove(&id)
                    .and_then(|mut s| s.child.wait().ok())
                    .map(|status| status.exit_code() as i32)
            };
            emitter.exit(&id, code);
        });
    }

    Ok(id)
}

pub fn write(registry: &PtyRegistry, session_id: &str, data: &str) -> DeckResult<()> {
    let mut sessions = registry.sessions.lock().expect("pty registry poisoned");
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| DeckError::NoSuchSession(session_id.to_string()))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| DeckError::Pty(e.to_string()))?;
    session
        .writer
        .flush()
        .map_err(|e| DeckError::Pty(e.to_string()))
}

pub fn resize(registry: &PtyRegistry, session_id: &str, cols: u16, rows: u16) -> DeckResult<()> {
    let sessions = registry.sessions.lock().expect("pty registry poisoned");
    let session = sessions
        .get(session_id)
        .ok_or_else(|| DeckError::NoSuchSession(session_id.to_string()))?;
    session
        .master
        .resize(PtySize {
            // A zero dimension makes some shells misbehave; the UI can briefly report 0
            // while its container is being laid out.
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| DeckError::Pty(e.to_string()))
}

/// Kills a session. Idempotent: killing an already-exited session is not an error, because the
/// reader thread may have reaped it a moment before the user clicked the close button.
pub fn kill(registry: &PtyRegistry, session_id: &str) -> DeckResult<()> {
    let mut sessions = registry.sessions.lock().expect("pty registry poisoned");
    if let Some(mut session) = sessions.remove(session_id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

/// Kills every live session. Called on app exit so no dev server or shell outlives the
/// window that started it (REQ-7, TASK-17).
pub fn kill_all(registry: &PtyRegistry) -> usize {
    let mut sessions = registry.sessions.lock().expect("pty registry poisoned");
    let count = sessions.len();
    for (_, mut session) in sessions.drain() {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    count
}

pub fn session_count(registry: &PtyRegistry) -> usize {
    registry
        .sessions
        .lock()
        .expect("pty registry poisoned")
        .len()
}

/// argv that runs `cmd` **through the user's shell**, with their profile loaded.
///
/// Spawning argv directly is right for a real program, but wrong for anything the shell itself
/// provides. worktrunk's `dev` alias is the case in point: `git-wt.exe dev` exits with
/// "unrecognized subcommand" because `dev` only exists as the wrapper function worktrunk
/// installs in the profile. Going through the shell is what makes it resolve.
///
/// The window is kept open after the command exits (`-NoExit`, `exec $SHELL`) so a dev server
/// that dies on startup leaves its error on screen instead of closing the tab.
pub fn shell_argv(cmd: &str) -> Vec<String> {
    let shell = default_shell();
    #[cfg(windows)]
    {
        // `-Command` loads the profile; only `-NoProfile` would skip it, which is exactly what
        // we must not do here.
        if shell.to_ascii_lowercase().ends_with("cmd.exe") {
            return vec![shell, "/k".into(), cmd.to_string()];
        }
        vec![shell, "-NoExit".into(), "-Command".into(), cmd.to_string()]
    }
    #[cfg(not(windows))]
    {
        // `-i` so the rc file that defines the wrapper is read; `-l` alone skips it on bash.
        vec![
            shell,
            "-ic".into(),
            format!("{cmd}; exec ${{SHELL:-/bin/sh}}"),
        ]
    }
}

/// The user's interactive shell. `SHELL`/`COMSPEC` are what the OS itself uses, so honour them
/// before falling back.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        // Prefer PowerShell — worktrunk's shell integration is installed in the PowerShell
        // profile, so `git-wt switch` only changes directory there.
        if let Ok(pwsh) = which_on_path("pwsh.exe") {
            return pwsh;
        }
        if let Ok(ps) = which_on_path("powershell.exe") {
            return ps;
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

#[cfg(windows)]
fn which_on_path(bin: &str) -> Result<String, ()> {
    let path = std::env::var_os("PATH").ok_or(())?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|c| c.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_is_never_empty() {
        assert!(!default_shell().is_empty());
    }

    #[test]
    fn killing_an_unknown_session_is_not_an_error() {
        let reg = PtyRegistry::new();
        assert!(kill(&reg, "pty-does-not-exist").is_ok());
    }

    #[test]
    fn writing_to_an_unknown_session_names_the_session() {
        let reg = PtyRegistry::new();
        assert!(matches!(
            write(&reg, "pty-nope", "ls\n"),
            Err(DeckError::NoSuchSession(_))
        ));
    }

    #[test]
    fn ids_are_unique() {
        let reg = PtyRegistry::new();
        let a = reg.new_id();
        let b = reg.new_id();
        assert_ne!(a, b);
    }

    #[test]
    fn kill_all_on_an_empty_registry_reports_zero() {
        let reg = PtyRegistry::new();
        assert_eq!(kill_all(&reg), 0);
        assert_eq!(session_count(&reg), 0);
    }

    #[test]
    fn opening_in_a_missing_directory_is_a_readable_error() {
        let reg = Arc::new(PtyRegistry::new());
        let err = open_with_emitter(
            Arc::new(Collected::default()),
            &reg,
            "/definitely/not/a/directory",
            None,
        )
        .unwrap_err();
        assert!(matches!(err, DeckError::Pty(_)));
    }

    /// Collects events so a test can assert on what the webview *would* have received.
    #[derive(Clone, Default)]
    struct Collected {
        output: Arc<Mutex<Vec<u8>>>,
        exited: Arc<Mutex<bool>>,
    }

    impl Collected {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.output.lock().unwrap().clone()).into_owned()
        }
    }

    impl PtyEmitter for Collected {
        fn output(&self, _session_id: &str, base64_bytes: String) {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(base64_bytes)
                .expect("emitted output must be valid base64");
            self.output.lock().unwrap().extend_from_slice(&decoded);
        }

        fn exit(&self, _session_id: &str, _code: Option<i32>) {
            *self.exited.lock().unwrap() = true;
        }
    }

    /// Answers the shell's cursor-position request, the way a real terminal does.
    ///
    /// PowerShell's PSReadLine (and readline-style prompts generally) emit a Device Status
    /// Report — `ESC[6n` — on startup and **block until the terminal replies** with
    /// `ESC[row;colR`. In the app xterm.js answers automatically, so this never comes up; in a
    /// headless test nothing answers and the shell hangs having printed only the query. Test
    /// harness detail only — there is nothing to fix in `open_with_emitter`.
    fn answer_cursor_position_report(registry: &PtyRegistry, id: &str, collected: &Collected) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !collected.text().contains("\u{1b}[6n") {
            if std::time::Instant::now() > deadline {
                return; // Shell never asked; nothing to answer.
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = write(registry, id, "\u{1b}[1;1R");
    }

    fn wait_for(collected: &Collected, needle: &str, what: &str) {
        // Poll rather than sleep a fixed time; PTY and shell startup vary wildly by machine.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if collected.text().contains(needle) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}; got: {:?}",
                collected.text()
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    /// The real thing: open an interactive shell in a PTY, type a command into it, and read
    /// the result back. This is what proves ConPTY (Windows) and openpty (Unix) actually
    /// work — the acceptance check for TASK-13 that no mock can stand in for.
    ///
    /// Deliberately an *interactive* shell rather than a one-shot `sh -c`: that is what REQ-7
    /// specifies, and on Windows a child that exits immediately can have its output discarded
    /// before ConPTY flushes the pseudoconsole, which makes the one-shot form flaky.
    #[test]
    fn a_real_interactive_pty_runs_a_typed_command() {
        let collected = Collected::default();
        let registry = Arc::new(PtyRegistry::new());
        let cwd = std::env::temp_dir();

        let id = open_with_emitter(
            Arc::new(collected.clone()),
            &registry,
            &cwd.to_string_lossy(),
            None, // the user's default shell — exactly what "Open terminal" does
        )
        .expect("a PTY should open in the temp directory");
        assert!(id.starts_with("pty-"));
        assert_eq!(session_count(&registry), 1);

        answer_cursor_position_report(&registry, &id, &collected);

        // Give the shell a moment to draw its prompt before typing into it.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        write(&registry, &id, "echo worktrunk-deck-pty-ok\r\n")
            .expect("writing to a live session should succeed");

        wait_for(
            &collected,
            "worktrunk-deck-pty-ok",
            "the echoed command output",
        );

        // Killing must remove it from the registry so nothing outlives the app (REQ-7).
        kill(&registry, &id).expect("kill should succeed");
        assert_eq!(session_count(&registry), 0);
    }

    /// Two sessions must be able to run at once and stay independent (REQ-7: "multiple
    /// concurrent sessions"), and `kill_all` must take both down (TASK-17).
    #[test]
    fn concurrent_sessions_are_independent_and_kill_all_clears_them() {
        let registry = Arc::new(PtyRegistry::new());
        let cwd = std::env::temp_dir();

        let a = Collected::default();
        let b = Collected::default();
        let id_a = open_with_emitter(Arc::new(a.clone()), &registry, &cwd.to_string_lossy(), None)
            .expect("first session opens");
        let id_b = open_with_emitter(Arc::new(b.clone()), &registry, &cwd.to_string_lossy(), None)
            .expect("second session opens");
        assert_ne!(id_a, id_b);
        assert_eq!(session_count(&registry), 2);

        answer_cursor_position_report(&registry, &id_a, &a);
        answer_cursor_position_report(&registry, &id_b, &b);

        std::thread::sleep(std::time::Duration::from_millis(1500));
        write(&registry, &id_a, "echo only-in-session-a\r\n").unwrap();

        wait_for(&a, "only-in-session-a", "session A's output");
        assert!(
            !b.text().contains("only-in-session-a"),
            "session B must not receive session A's output"
        );

        assert_eq!(kill_all(&registry), 2);
        assert_eq!(session_count(&registry), 0);
    }
}
