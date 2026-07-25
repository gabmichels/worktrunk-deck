/**
 * Blocks the app until both preconditions of REQ-1 are met: at least one repo is configured
 * (explicit list or a scan root that actually finds git repos) and `git-wt` resolves. Calls
 * `onDone` the moment both are true — the caller decides what "done" means (usually: stop
 * rendering this gate and start `useWorktrees`).
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, FolderOpen, Plus, RefreshCw, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { InstallWorktrunk } from "@/components/InstallWorktrunk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfig } from "@/hooks/useConfig";
import * as ipc from "@/lib/ipc";
import type { DeckConfig, RootValidation } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FirstRunGate({ onDone }: { onDone: () => void }) {
  const { config, gitWt, save, reload } = useConfig();
  const [draft, setDraft] = useState<DeckConfig>(config);
  const [newRepoPath, setNewRepoPath] = useState("");
  const [rootValidation, setRootValidation] = useState<RootValidation | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(config), [config]);

  useEffect(() => {
    if (!draft.scanRoot) {
      setRootValidation(null);
      return;
    }
    const handle = window.setTimeout(() => {
      ipc
        .validateRoot(draft.scanRoot!)
        .then(setRootValidation)
        .catch((e) =>
          setRootValidation({ ok: false, repoCount: 0, rootIsRepo: false, error: String(e) }),
        );
    }, 400);
    return () => window.clearTimeout(handle);
  }, [draft.scanRoot]);

  const hasRepos = draft.repos.length > 0 || Boolean(rootValidation?.ok && rootValidation.repoCount > 0);
  const gitWtOk = gitWt?.ok === true;
  const ready = hasRepos && gitWtOk;

  function patch(next: Partial<DeckConfig>) {
    setDraft((d) => ({ ...d, ...next }));
  }

  function addRepo(path: string) {
    const trimmed = path.trim();
    if (!trimmed || draft.repos.includes(trimmed)) return;
    patch({ repos: [...draft.repos, trimmed] });
    setNewRepoPath("");
  }

  function removeRepo(path: string) {
    patch({ repos: draft.repos.filter((r) => r !== path) });
  }

  async function browseFor(kind: "scanRoot" | "repo" | "gitWtPath") {
    const selected = await openDialog({ directory: kind !== "gitWtPath", multiple: false });
    if (typeof selected !== "string") return;
    if (kind === "scanRoot") patch({ scanRoot: selected });
    else if (kind === "gitWtPath") patch({ gitWtPath: selected });
    else addRepo(selected);
  }

  async function handleContinue() {
    setSaving(true);
    try {
      await save(draft);
      if (ready) onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-background flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="border-border bg-card w-full max-w-lg space-y-6 rounded-xl border p-6">
        <div>
          <h1 className="text-[15px] font-semibold">Welcome to worktrunk-deck</h1>
          <p className="text-muted-foreground mt-1 text-[12px]">
            Two things are needed before the dashboard can show anything: a `git-wt` binary and
            at least one repository.
          </p>
        </div>

        {/* Step 1: git-wt */}
        <section className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <StepIcon ok={gitWtOk} />
            <Label className="text-[12px]">1. Locate `git-wt`</Label>
          </div>
          <p className={cn("pl-5 text-[11px]", gitWtOk ? "text-ok" : "text-muted-foreground")}>
            {gitWt === null
              ? "Checking PATH…"
              : gitWt.ok
                ? `Found git-wt ${gitWt.version} at ${gitWt.path}`
                : `${gitWt.error} — install worktrunk, or point to the binary below.`}
          </p>
          {!gitWtOk && (
            <div className="space-y-2 pl-5">
              <InstallWorktrunk />
              <div className="space-y-1">
                <p className="text-muted-foreground text-[11px]">
                  Already installed? GUI apps inherit a shorter PATH than your shell, so point
                  at the binary directly:
                </p>
                <div className="flex gap-1.5">
                  <Input
                    value={draft.gitWtPath ?? ""}
                    onChange={(e) => patch({ gitWtPath: e.target.value || undefined })}
                    placeholder="Path to the git-wt binary"
                    className="font-mono text-[12px]"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void browseFor("gitWtPath")}
                    aria-label="Browse for the git-wt binary"
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void reload()}
                    aria-label="Re-check for git-wt"
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Step 2: repos */}
        <section className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <StepIcon ok={hasRepos} />
            <Label className="text-[12px]">2. Add repositories</Label>
          </div>

          {draft.repos.length > 0 && (
            <ul className="space-y-1 pl-5">
              {draft.repos.map((repo) => (
                <li
                  key={repo}
                  className="border-border bg-background flex items-center gap-2 rounded-md border px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={repo}>
                    {repo}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    onClick={() => removeRepo(repo)}
                    aria-label={`Remove ${repo}`}
                  >
                    <X className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-1.5 pl-5">
            <Input
              value={newRepoPath}
              onChange={(e) => setNewRepoPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRepo(newRepoPath)}
              placeholder="Explicit repo path"
              className="font-mono text-[12px]"
            />
            <Button variant="outline" size="sm" onClick={() => void browseFor("repo")} aria-label="Browse for a repo">
              <FolderOpen className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addRepo(newRepoPath)}
              disabled={!newRepoPath.trim()}
              aria-label="Add repo"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>

          <p className="text-muted-foreground pl-5 text-[11px]">or auto-discover under a directory:</p>
          <div className="flex gap-1.5 pl-5">
            <Input
              value={draft.scanRoot ?? ""}
              onChange={(e) => patch({ scanRoot: e.target.value || undefined })}
              placeholder="Scan root"
              className="font-mono text-[12px]"
            />
            <Button variant="outline" size="sm" onClick={() => void browseFor("scanRoot")} aria-label="Browse for a scan root">
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
          {draft.scanRoot && rootValidation && (
            <p className={cn("pl-5 text-[11px]", rootValidation.ok ? "text-ok" : "text-destructive")}>
              {rootValidation.ok
                ? rootValidation.rootIsRepo
                  ? "This folder is itself a repository — its worktrees will be shown"
                  : `Workspace OK — ${rootValidation.repoCount} repos found`
                : (rootValidation.error ?? "Could not scan this directory.")}
            </p>
          )}
        </section>

        <Button className="w-full" onClick={() => void handleContinue()} disabled={saving}>
          {saving ? "Saving…" : ready ? "Continue" : "Save and check again"}
        </Button>
      </div>
    </div>
  );
}

function StepIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="text-ok size-3.5 shrink-0" aria-hidden />
  ) : (
    <XCircle className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
  );
}
