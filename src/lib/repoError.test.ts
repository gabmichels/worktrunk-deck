import { describe, expect, it } from "vitest";

import { diagnoseRepoError } from "./repoError";

const DUBIOUS_OWNERSHIP_ERROR = `\`git-wt -C C:\\Workspace\\cw-lead-gen list --format json\` failed (non-zero): ✗ Command failed
  fatal: detected dubious ownership in repository at 'C:/Workspace/cw-lead-gen'
  'C:/Workspace/cw-lead-gen' is owned by:
      BUILTIN/Administrators (S-1-5-32-544)
  but the current user is:
      ...
  To add an exception for this directory, call:
      git config --global --add safe.directory C:/Workspace/cw-lead-gen`;

describe("diagnoseRepoError", () => {
  it("detects dubious ownership and produces a forward-slash safe.directory fix", () => {
    const hint = diagnoseRepoError(DUBIOUS_OWNERSHIP_ERROR, "C:\\Workspace\\cw-lead-gen");
    expect(hint.kind).toBe("dubious-ownership");
    expect(hint.title).toBe("git does not trust this repository's ownership");
    expect(hint.fixCommand).toBe(
      "git config --global --add safe.directory C:/Workspace/cw-lead-gen",
    );
  });

  it("falls back to unknown for an unrelated error", () => {
    const hint = diagnoseRepoError(
      "fatal: not a git repository (or any of the parent directories): .git",
      "C:\\Workspace\\some-repo",
    );
    expect(hint.kind).toBe("unknown");
    expect(hint.fixCommand).toBeUndefined();
  });
});
