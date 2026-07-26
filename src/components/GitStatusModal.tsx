/**
 * The working tree in detail: which files are staged, edited, or untracked.
 *
 * The card's indicator says *what kind* of change exists; this answers *which files*. It is
 * strictly read-only — the deck does not stage, discard or commit anything (spec Non-goals).
 * Anything you would do about what you see here belongs in a terminal, which is one click away.
 */
import { AlertTriangle, ArrowRight, FileQuestion, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { messageOf } from "@/hooks/useConfig";
import {
  groupStatus,
  labelFor,
  totalChanges,
  type ChangeKind,
  type GroupedStatus,
  type StatusLine,
} from "@/lib/gitStatus";
import * as ipc from "@/lib/ipc";
import type { Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<ChangeKind, ReactNode> = {
  modified: <Pencil className="size-3" aria-hidden />,
  added: <Plus className="size-3" aria-hidden />,
  deleted: <Trash2 className="size-3" aria-hidden />,
  renamed: <ArrowRight className="size-3" aria-hidden />,
  copied: <Plus className="size-3" aria-hidden />,
  conflicted: <AlertTriangle className="size-3" aria-hidden />,
  untracked: <FileQuestion className="size-3" aria-hidden />,
};

const KIND_CLASS: Record<ChangeKind, string> = {
  modified: "text-warn",
  added: "text-ok",
  deleted: "text-destructive",
  renamed: "text-warn",
  copied: "text-ok",
  conflicted: "text-destructive",
  untracked: "text-muted-foreground",
};

export function GitStatusModal({
  worktree,
  open,
  onOpenChange,
}: {
  worktree: Worktree;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [status, setStatus] = useState<GroupedStatus | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-read on every open rather than caching: the whole point is to reflect the working tree
  // as it is right now, and it changes constantly while you work.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    ipc
      .gitStatus(worktree.path)
      .then((result) => {
        if (!alive) return;
        setStatus(groupStatus(result.entries));
        setTruncated(result.truncated);
      })
      .catch((e: unknown) => alive && setError(messageOf(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, worktree.path]);

  const count = status ? totalChanges(status) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{worktree.branch}</DialogTitle>
          <DialogDescription>
            Working tree of <span className="font-mono">{worktree.path}</span>. Read-only — use a
            terminal to stage or discard.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="text-muted-foreground flex items-center gap-1.5 px-1 py-2 text-[12px]">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Reading working tree…
            </div>
          )}

          {error && (
            <div className="text-destructive flex items-start gap-1.5 px-1 py-2 text-[12px]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>Could not read status: {error}</span>
            </div>
          )}

          {!loading && !error && status && count === 0 && (
            <p className="text-muted-foreground px-1 py-2 text-[12px]">
              Nothing to commit — the working tree is clean.
            </p>
          )}

          {!loading && !error && status && count > 0 && (
            <div className="space-y-3">
              <Group
                title="Staged"
                hint="Included if you commit right now"
                lines={status.staged}
              />
              <Group
                title="Not staged"
                hint="Edited but not added to the next commit"
                lines={status.unstaged}
              />
              <Group
                title="Untracked"
                hint="New files git is not tracking"
                lines={status.untracked}
              />
            </div>
          )}

          {truncated && (
            <p className="text-muted-foreground mt-2 px-1 text-[11px]">
              Only the first entries are shown — this working tree has more changes than the list
              will display.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Group({
  title,
  hint,
  lines,
}: {
  title: string;
  hint: string;
  lines: StatusLine[];
}) {
  // An empty group is noise, not information — git itself omits them.
  if (lines.length === 0) return null;

  return (
    <section>
      <header className="flex items-baseline gap-2 px-1 pb-1">
        <h3 className="text-[12px] font-semibold">{title}</h3>
        <span className="text-muted-foreground font-mono text-[11px]">{lines.length}</span>
        <span className="text-muted-foreground text-[11px]">{hint}</span>
      </header>
      <ul className="border-border divide-border divide-y rounded-md border">
        {lines.map((line) => (
          <li
            key={`${title}:${line.path}`}
            className="flex items-center gap-2 px-2 py-1 text-[12px]"
          >
            <span className={cn("shrink-0", KIND_CLASS[line.kind])}>{KIND_ICON[line.kind]}</span>
            <span className="min-w-0 flex-1 truncate font-mono" title={line.path}>
              {line.originalPath ? (
                <>
                  <span className="text-muted-foreground">{line.originalPath}</span>
                  <span className="text-muted-foreground px-1">→</span>
                  {line.path}
                </>
              ) : (
                line.path
              )}
            </span>
            <span className={cn("shrink-0 text-[11px]", KIND_CLASS[line.kind])}>
              {labelFor(line.kind)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
