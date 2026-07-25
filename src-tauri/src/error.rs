use serde::Serialize;

/// Every `#[tauri::command]` returns `Result<_, DeckError>`; it serializes to a plain
/// string so the frontend can surface it verbatim (REQ-15: errors are shown, not swallowed).
#[derive(Debug, thiserror::Error)]
pub enum DeckError {
    #[error("{0}")]
    Config(String),

    #[error("`git-wt` is not available: {0}")]
    GitWtMissing(String),

    /// A subcommand outside the allowlist was requested (NFR-3).
    #[error("refusing to run `git-wt {0}` — not in the allowlist (list, switch, merge, remove)")]
    NotAllowed(String),

    #[error("`git-wt {args}` failed ({code}): {stderr}")]
    GitWtFailed {
        args: String,
        code: String,
        stderr: String,
    },

    #[error("`git-wt` returned output that is not valid JSON: {0}")]
    BadJson(String),

    #[error("terminal session {0} is not open")]
    NoSuchSession(String),

    #[error("{0}")]
    Pty(String),

    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for DeckError {
    fn from(e: std::io::Error) -> Self {
        DeckError::Io(e.to_string())
    }
}

impl Serialize for DeckError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type DeckResult<T> = Result<T, DeckError>;
