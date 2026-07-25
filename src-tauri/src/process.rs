//! Process-spawn helpers shared by `config.rs`, `gitwt.rs` and `external.rs`.
//!
//! Their only job is to keep Windows from flashing a console window for every child we spawn —
//! the deck can invoke `git-wt` once per repo per refresh, and without this the screen blinks.

use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A blocking `std::process::Command` that stays invisible on Windows.
pub fn command(program: impl AsRef<Path>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program.as_ref());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The async equivalent, used for the parallel per-repo fan-out (NFR-4/5).
pub fn async_command(program: impl AsRef<Path>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program.as_ref());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
