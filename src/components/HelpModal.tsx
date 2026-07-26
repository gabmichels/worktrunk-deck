/**
 * A legend for every status icon plus an action glossary (REQ-14). Imports the real
 * `StatusDot` so this legend can never drift from what the cards actually render — if a new
 * tone is added to `StatusDot`, this file needs an entry too, but it can't silently describe a
 * dot that no longer matches reality.
 */
import { AlertTriangle, FolderCog, GitMerge, Globe, Pencil, Terminal, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { StatusDot } from "@/components/StatusDot";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function HelpModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1 text-[12px]">
          <section className="space-y-2">
            <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
              Status icons
            </h3>
            <dl className="space-y-2">
              <LegendRow icon={<StatusDot tone="ok" />} term="Clean">
                Nothing to commit — no changes, and no untracked files.
              </LegendRow>
              <LegendRow icon={<StatusDot tone="untracked" />} term="Untracked only">
                New files git is not tracking, but nothing already committed has been edited —
                often a <code className="font-mono">.config/</code> directory, build output or a
                scratch file. Separated from "dirty" because it does not mean work in progress.
              </LegendRow>
              <LegendRow icon={<StatusDot tone="dirty" />} term="Dirty">
                Files that are already committed have been staged, modified, renamed or deleted.
                The diff counts next to the branch are added/deleted line totals for tracked
                changes only.
              </LegendRow>
              <LegendRow term="Ahead/behind (e.g. 2/1)">
                Commits ahead / behind the repo's default branch (top number) and the tracking
                branch (bottom number). A dash (—) on the remote line means the branch has no
                upstream at all, which is different from being in sync.
              </LegendRow>
              <LegendRow icon={<StatusDot tone="live" pulse />} term="Listening">
                worktrunk reports this worktree's dev-server URL as currently accepting
                connections. The deck never probes ports itself — this reflects `git-wt list`
                exactly.
              </LegendRow>
              <LegendRow icon={<StatusDot tone="idle" />} term="Assigned, not listening">
                A port is reserved for this worktree but nothing is currently running on it.
              </LegendRow>
              <LegendRow
                icon={<AlertTriangle className="text-destructive size-3.5" aria-hidden />}
                term="Unreadable repo"
              >
                worktrunk could not read this repository (bad path, not a git repo, `git-wt`
                error). Shown inline so the rest of the dashboard keeps working (REQ-15).
              </LegendRow>
            </dl>
          </section>

          <section className="space-y-2">
            <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
              Actions
            </h3>
            <dl className="space-y-2">
              <LegendRow icon={<Terminal className="size-3.5" aria-hidden />} term="Open terminal">
                Opens an interactive shell rooted in that worktree's directory.
              </LegendRow>
              <LegendRow icon={<Globe className="size-3.5" aria-hidden />} term="Run dev / Open URL">
                Runs the repo's configured dev command in a terminal tab, or opens an already
                running dev-server URL in your browser.
              </LegendRow>
              <LegendRow icon={<GitMerge className="size-3.5" aria-hidden />} term="Merge">
                Merges the worktree's branch into the default branch via `git-wt merge`.
                Confirms first unless disabled in Settings.
              </LegendRow>
              <LegendRow icon={<Trash2 className="size-3.5" aria-hidden />} term="Remove">
                Removes the worktree via `git-wt remove`. Confirms first unless disabled in
                Settings.
              </LegendRow>
              <LegendRow icon={<Pencil className="size-3.5" aria-hidden />} term="Open in editor">
                Opens the worktree directory in your configured editor.
              </LegendRow>
              <LegendRow icon={<FolderCog className="size-3.5" aria-hidden />} term="Run externally">
                Launches the dev command in your OS terminal instead of the integrated one.
              </LegendRow>
            </dl>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LegendRow({
  icon,
  term,
  children,
}: {
  icon?: ReactNode;
  term: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5">
      <div className="flex w-5 shrink-0 items-center justify-center pt-0.5">{icon}</div>
      <div className="min-w-0">
        <dt className="font-medium">{term}</dt>
        <dd className="text-muted-foreground">{children}</dd>
      </div>
    </div>
  );
}
