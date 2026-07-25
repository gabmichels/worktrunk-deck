/**
 * Per-worktree action menu (REQ-6): terminal, dev server, editor, dev URL, copy path, merge,
 * remove. Merge/remove are destructive and gated behind confirmation per `config.confirmDestructive`
 * (REQ-12) — when that setting is off, they fire immediately.
 *
 * Force-remove is a two-step escalation, never a default: we call `removeWorktree` without
 * `force` first, and only offer a force retry after worktrunk itself refuses, showing its
 * stderr verbatim as the reason (REQ-15) so the user knows exactly what they'd be discarding.
 */
import {
  Copy,
  ExternalLink,
  FolderOpen,
  GitMerge,
  Play,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfig } from "@/hooks/useConfig";
import type { UseCliRun } from "@/hooks/useCliRun";
import * as ipc from "@/lib/ipc";
import type { Worktree } from "@/lib/types";

export function WorktreeActions({
  worktree,
  run,
  onChanged,
  onOpenTerminal,
  onRunDev,
}: {
  worktree: Worktree;
  run: UseCliRun;
  onChanged: () => void;
  onOpenTerminal?: (w: Worktree) => void;
  onRunDev?: (w: Worktree) => void;
}) {
  const { config } = useConfig();
  const [confirmKind, setConfirmKind] = useState<"merge" | "remove" | null>(null);
  // Populated once worktrunk has refused a plain remove; drives the force-escalation dialog.
  const [removeRefusal, setRemoveRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const w = worktree;

  function requestMerge() {
    if (config.confirmDestructive) {
      setConfirmKind("merge");
    } else {
      void doMerge();
    }
  }

  function requestRemove() {
    setRemoveRefusal(null);
    if (config.confirmDestructive) {
      setConfirmKind("remove");
    } else {
      void doRemove(false);
    }
  }

  async function doMerge() {
    setConfirmKind(null);
    await run.start(`Merge ${w.branch}`, () => ipc.mergeWorktree(w.repoPath, w.branch));
    onChanged();
  }

  async function doRemove(force: boolean) {
    setConfirmKind(null);
    setBusy(true);
    try {
      const result = await ipc.removeWorktree(w.repoPath, w.branch, force);
      if (result.ok) {
        setRemoveRefusal(null);
        toast.success(`Removed ${w.branch}`);
        onChanged();
      } else if (!force) {
        // Plain remove refused (e.g. dirty tree) — surface worktrunk's own reason and offer the
        // force escalation as a distinct, explicit follow-up action (never automatic).
        setRemoveRefusal(result.stderr || "git-wt refused to remove this worktree.");
      } else {
        toast.error(`Force-remove failed for ${w.branch}`, { description: result.stderr });
      }
    } catch (e) {
      toast.error(`Remove failed for ${w.branch}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(w.path);
      toast.success("Path copied");
    } catch {
      toast.error("Could not copy path");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${w.branch}`}>
            <span aria-hidden className="text-base leading-none">
              ⋯
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {onOpenTerminal && (
            <DropdownMenuItem onSelect={() => onOpenTerminal(w)}>
              <TerminalIcon /> Open terminal
            </DropdownMenuItem>
          )}
          {onRunDev && (
            <DropdownMenuItem onSelect={() => onRunDev(w)}>
              <Play /> Run dev
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void ipc.openInEditor(w.path)}>
            <FolderOpen /> Open in editor
          </DropdownMenuItem>
          {w.url && (
            <DropdownMenuItem onSelect={() => void ipc.openUrl(w.url!)}>
              <ExternalLink /> Open {w.url}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void copyPath()}>
            <Copy /> Copy path
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={w.isMain || busy} onSelect={requestMerge}>
            <GitMerge /> Merge into default branch
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={w.isMain || busy}
            onSelect={requestRemove}
          >
            <Trash2 /> Remove worktree
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmKind === "merge"} onOpenChange={(o) => !o && setConfirmKind(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Merge {w.branch}?</AlertDialogTitle>
          <AlertDialogDescription>
            This runs <code className="font-mono">git-wt merge</code> for{" "}
            <span className="font-mono">{w.branch}</span>, merging it into the repo's default
            branch. This changes branch history and cannot be undone from here.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doMerge()}>Merge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmKind === "remove"}
        onOpenChange={(o) => !o && setConfirmKind(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Remove {w.branch}?</AlertDialogTitle>
          <AlertDialogDescription>
            This runs <code className="font-mono">git-wt remove</code> for{" "}
            <span className="font-mono">{w.branch}</span>, deleting its worktree directory at{" "}
            <span className="font-mono">{w.path}</span>. Committed history on the branch is not
            deleted.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doRemove(false)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force-escalation: only reachable after a plain remove has already been refused by
          worktrunk. Its stderr is shown verbatim so the user knows exactly what refused it
          (e.g. uncommitted changes) before agreeing to discard it (REQ-15, REQ-12). */}
      <AlertDialog open={removeRefusal !== null} onOpenChange={(o) => !o && setRemoveRefusal(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>git-wt refused to remove {w.branch}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <pre className="bg-background border-border max-h-40 overflow-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
                {removeRefusal}
              </pre>
              <span>
                Forcing removal discards any uncommitted work in this worktree. This cannot be
                undone.
              </span>
            </div>
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doRemove(true)}>
              Force remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
