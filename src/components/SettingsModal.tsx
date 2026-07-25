/**
 * Exposes every `DeckConfig` field (plan §3.3, REQ-13). Edits are staged in local state and
 * only committed via `useConfig().save` when the user clicks Save — reopening after Cancel must
 * show the persisted config again, not a half-edited draft.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConfig } from "@/hooks/useConfig";
import * as ipc from "@/lib/ipc";
import type { DeckConfig, DevCommand, RootValidation, Theme } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Rejects anything that could let a dev-server `cwd` escape the worktree it belongs to. */
function validateCwd(cwd: string): string | null {
  if (!cwd) return null;
  if (/^([a-zA-Z]:)?[\\/]/.test(cwd)) return "Must be relative to the worktree root, not absolute.";
  if (cwd.split(/[\\/]/).includes("..")) return "Must stay inside the worktree — \"..\" is not allowed.";
  return null;
}

/** Debounce for live `validate_root` calls so every keystroke doesn't spawn a probe (REQ-13). */
const VALIDATE_DEBOUNCE_MS = 400;

export function SettingsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { config, gitWt, save } = useConfig();
  const [draft, setDraft] = useState<DeckConfig>(config);
  const [newRepoPath, setNewRepoPath] = useState("");
  const [rootValidation, setRootValidation] = useState<RootValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed the draft from the persisted config every time the modal opens, so a Cancel
  // (or simply closing without saving) never leaks a stale edit into the next open.
  useEffect(() => {
    if (open) setDraft(config);
  }, [open, config]);

  // Live "Workspace OK — N repos found" for the scan root (REQ-13).
  useEffect(() => {
    if (!open || !draft.scanRoot) {
      setRootValidation(null);
      return;
    }
    setValidating(true);
    const handle = window.setTimeout(() => {
      ipc
        .validateRoot(draft.scanRoot!)
        .then(setRootValidation)
        .catch((e) => setRootValidation({ ok: false, repoCount: 0, error: String(e) }))
        .finally(() => setValidating(false));
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [open, draft.scanRoot]);

  function patch(next: Partial<DeckConfig>) {
    setDraft((d) => ({ ...d, ...next }));
  }

  // Repos to offer dev-command editing for: every configured repo, plus any devByRepo entry
  // left over from a repo removed above but not yet saved — so it stays visible and editable
  // (e.g. to clear it) rather than silently vanishing.
  const devCommandRepos = Array.from(
    new Set([...draft.repos, ...Object.keys(draft.devByRepo ?? {})]),
  );

  const hasInvalidCwd = Object.values(draft.devByRepo ?? {}).some(
    (d) => validateCwd(d.cwd ?? "") !== null,
  );

  async function handleSave() {
    setSaving(true);
    try {
      await save(draft);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function browseFor(kind: "scanRoot" | "repo" | "gitWtPath") {
    const selected = await openDialog({
      directory: kind !== "gitWtPath",
      multiple: false,
    });
    if (typeof selected !== "string") return;
    if (kind === "scanRoot") patch({ scanRoot: selected });
    else if (kind === "gitWtPath") patch({ gitWtPath: selected });
    else addRepo(selected);
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

  // Free-text command input, split on spaces into argv, keyed by repo path so the parsed
  // preview below can show exactly what will be executed (quoting surprises included).
  function setDevCommandText(repoPath: string, text: string) {
    const command = text.trim().length > 0 ? text.trim().split(/\s+/) : [];
    const existing = draft.devByRepo?.[repoPath];
    const next: DevCommand = { ...existing, command };
    patch({ devByRepo: { ...draft.devByRepo, [repoPath]: next } });
  }

  function setDevCwd(repoPath: string, cwd: string) {
    const existing = draft.devByRepo?.[repoPath] ?? { command: [] };
    patch({
      devByRepo: { ...draft.devByRepo, [repoPath]: { ...existing, cwd: cwd || undefined } },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
          {/* Repos + scan root — REQ-1, REQ-13 */}
          <section className="space-y-2">
            <Label>Repositories</Label>
            {draft.repos.length > 0 && (
              <ul className="space-y-1">
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
            <div className="flex gap-1.5">
              <Input
                value={newRepoPath}
                onChange={(e) => setNewRepoPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addRepo(newRepoPath)}
                placeholder="Explicit repo path"
                className="font-mono text-[12px]"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void browseFor("repo")}
                aria-label="Browse for a repo"
              >
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
          </section>

          <section className="space-y-1.5">
            <Label htmlFor="scan-root">Scan root (optional)</Label>
            <div className="flex gap-1.5">
              <Input
                id="scan-root"
                value={draft.scanRoot ?? ""}
                onChange={(e) => patch({ scanRoot: e.target.value || undefined })}
                placeholder="Auto-discover git repos under this directory"
                className="font-mono text-[12px]"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void browseFor("scanRoot")}
                aria-label="Browse for a scan root"
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </div>
            {draft.scanRoot && (
              <p
                className={cn(
                  "text-[11px]",
                  validating
                    ? "text-muted-foreground"
                    : rootValidation?.ok
                      ? "text-ok"
                      : "text-destructive",
                )}
              >
                {validating
                  ? "Checking…"
                  : rootValidation?.ok
                    ? `Workspace OK — ${rootValidation.repoCount} repos found`
                    : (rootValidation?.error ?? "Not checked yet")}
              </p>
            )}
          </section>

          {/* Dev commands — per-repo "Run dev" command + cwd, keyed by repo path. Offered for
              every configured repo plus any leftover devByRepo entries (e.g. a repo just
              removed above but not yet saved), so a stale entry is visible and removable. */}
          <section className="space-y-2">
            <Label>Dev commands</Label>
            <p className="text-muted-foreground text-[11px]">
              Command to run for this repo's "Run dev" action. Working directory is relative to
              the worktree, not the repo root — leave blank for the worktree root itself.
            </p>
            {devCommandRepos.length === 0 ? (
              <p className="text-muted-foreground text-[11px]">Add a repository above first.</p>
            ) : (
              <ul className="space-y-2">
                {devCommandRepos.map((repoPath) => {
                  const dev = draft.devByRepo?.[repoPath];
                  const commandText = (dev?.command ?? []).join(" ");
                  const cwdError = validateCwd(dev?.cwd ?? "");
                  return (
                    <li
                      key={repoPath}
                      className="border-border bg-background space-y-1.5 rounded-md border px-2 py-1.5"
                    >
                      <span
                        className="text-muted-foreground block truncate font-mono text-[11px]"
                        title={repoPath}
                      >
                        {repoPath}
                      </span>
                      <div className="space-y-1">
                        <Input
                          value={commandText}
                          onChange={(e) => setDevCommandText(repoPath, e.target.value)}
                          placeholder="pnpm dev"
                          className="font-mono text-[12px]"
                          aria-label={`Dev command for ${repoPath}`}
                        />
                        {dev && dev.command.length > 0 && (
                          <p className="text-muted-foreground font-mono text-[11px]">
                            argv: [{dev.command.map((a) => `"${a}"`).join(", ")}]
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Input
                          value={dev?.cwd ?? ""}
                          onChange={(e) => setDevCwd(repoPath, e.target.value)}
                          placeholder="Relative to worktree root, e.g. apps/web (blank = worktree root)"
                          className="font-mono text-[12px]"
                          aria-label={`Dev working directory for ${repoPath}`}
                        />
                        {cwdError ? (
                          <p className="text-destructive text-[11px]">{cwdError}</p>
                        ) : (
                          <p className="text-muted-foreground font-mono text-[11px]">
                            {`<worktree>${dev?.cwd ? `/${dev.cwd}` : ""}`}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* git-wt binary — REQ-13, spec §7 risk */}
          <section className="space-y-1.5">
            <Label htmlFor="gitwt-path">git-wt path override (optional)</Label>
            <div className="flex gap-1.5">
              <Input
                id="gitwt-path"
                value={draft.gitWtPath ?? ""}
                onChange={(e) => patch({ gitWtPath: e.target.value || undefined })}
                placeholder="Leave blank to search PATH"
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
            </div>
            <p className={cn("text-[11px]", gitWt?.ok ? "text-ok" : "text-destructive")}>
              {gitWt === null
                ? "Resolving…"
                : gitWt.ok
                  ? `Found git-wt ${gitWt.version} at ${gitWt.path}`
                  : gitWt.error}
              {" — re-checked after Save."}
            </p>
          </section>

          {/* Refresh + theme — REQ-11, NFR-7 */}
          <section className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="auto-refresh">Auto-refresh (ms, 0 = off)</Label>
              <Input
                id="auto-refresh"
                type="number"
                min={0}
                step={500}
                value={draft.autoRefreshMs}
                onChange={(e) => patch({ autoRefreshMs: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="theme">Theme</Label>
              <Select value={draft.theme} onValueChange={(v) => patch({ theme: v as Theme })}>
                <SelectTrigger id="theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          {/* External terminal — REQ-8 */}
          <section className="space-y-1.5">
            <Label htmlFor="external-terminal">External terminal (optional)</Label>
            <Input
              id="external-terminal"
              value={draft.externalTerminal ?? ""}
              onChange={(e) => patch({ externalTerminal: e.target.value || undefined })}
              placeholder="Auto-detect (e.g. wt, iterm2, warp, gnome-terminal)"
              className="font-mono text-[12px]"
            />
          </section>

          {/* Confirm destructive — REQ-12 */}
          <section className="flex items-center justify-between">
            <div>
              <Label htmlFor="confirm-destructive">Confirm before merge/remove</Label>
              <p className="text-muted-foreground text-[11px]">
                Uncheck to skip the confirmation dialog on destructive actions.
              </p>
            </div>
            <Switch
              id="confirm-destructive"
              checked={draft.confirmDestructive}
              onCheckedChange={(checked) => patch({ confirmDestructive: checked })}
            />
          </section>

          {/* Cross-repo grouping — REQ-4 */}
          <section className="flex items-center justify-between">
            <div>
              <Label htmlFor="cross-repo-grouping">Cross-repo feature grouping</Label>
              <p className="text-muted-foreground text-[11px]">
                Display worktrees sharing a branch name across repos as one group. Display only
                — never issues cross-repo git operations.
              </p>
            </div>
            <Switch
              id="cross-repo-grouping"
              checked={draft.crossRepoGrouping}
              onCheckedChange={(checked) => patch({ crossRepoGrouping: checked })}
            />
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving || hasInvalidCwd}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
