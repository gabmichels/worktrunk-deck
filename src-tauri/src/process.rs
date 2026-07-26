//! Process-spawn helpers shared by `config.rs`, `gitwt.rs` and `external.rs`.
//!
//! Their only job is to keep Windows from flashing a console window for every child we spawn —
//! the deck can invoke `git-wt` once per repo per refresh, and without this the screen blinks.

use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// `mut` is only needed by the Windows-only `creation_flags` call below, so on every other
// platform it is an unused-mut error under `-D warnings`.

/// A blocking `std::process::Command` that stays invisible on Windows.
pub fn command(program: impl AsRef<Path>) -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = std::process::Command::new(program.as_ref());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The opposite: a child that is *supposed* to be seen — an external terminal.
///
/// This distinction is not cosmetic. `CREATE_NO_WINDOW` on a console program means it runs with
/// no console at all, so "open PowerShell here" started a headless shell the user could never
/// see or type into. `CREATE_NEW_CONSOLE` gives it its own window and is ignored by GUI
/// programs, so one helper covers both kinds of terminal.
pub fn windowed_command(program: impl AsRef<Path>) -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = std::process::Command::new(program.as_ref());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    cmd
}

/// Finds an executable on `PATH`.
pub fn which(bin: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|c| c.is_file())
}

/// The async equivalent, used for the parallel per-repo fan-out (NFR-4/5).
pub fn async_command(program: impl AsRef<Path>) -> tokio::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = tokio::process::Command::new(program.as_ref());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
