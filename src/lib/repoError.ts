/**
 * Turns raw `git-wt` stderr into an actionable hint (REQ-15 upgrade). The app never runs the
 * fix itself (NFR-3) — we only recognize known failure shapes and hand back a copy-pasteable
 * command, never an IPC call that executes git.
 */

export interface RepoErrorHint {
  kind: "dubious-ownership" | "unknown";
  title: string;
  fixCommand?: string;
}

/** Git's own message, present regardless of locale settings we don't control. */
const DUBIOUS_OWNERSHIP_MARKER = "detected dubious ownership in repository";

export function diagnoseRepoError(error: string, repoPath: string): RepoErrorHint {
  if (error.includes(DUBIOUS_OWNERSHIP_MARKER)) {
    return {
      kind: "dubious-ownership",
      title: "git does not trust this repository's ownership",
      // git's own safe.directory config wants forward slashes even on Windows.
      fixCommand: `git config --global --add safe.directory ${repoPath.replace(/\\/g, "/")}`,
    };
  }
  return { kind: "unknown", title: "This repository could not be read." };
}
