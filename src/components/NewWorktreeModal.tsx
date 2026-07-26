/**
 * "New worktree" modal: pick a repo, name a branch, delegate to `git-wt switch --create` (REQ-5).
 *
 * The run itself happens in a terminal session, not in this dialog. `switch --create` asks for
 * one-time approval of a repo's project hooks, and an earlier version streamed it through a pipe
 * — which could show the prompt but never answer it, leaving the dialog stuck on "Creating…"
 * with no way to cancel. So the dialog's job ends at "start it and get out of the way".
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function NewWorktreeModal({
  open,
  onOpenChange,
  repos,
  onCreate,
  defaultRepoPath,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  repos: { repo: string; repoPath: string }[];
  /** Starts the run and surfaces it as a terminal tab. Resolves once it has been started. */
  onCreate: (repoPath: string, branch: string) => Promise<void>;
  /** The repo selected in the list, if any — saves picking it again here. */
  defaultRepoPath?: string | null;
}) {
  const [repoPath, setRepoPath] = useState<string>("");
  const [branch, setBranch] = useState("");
  const [starting, setStarting] = useState(false);

  // Resolved when the dialog opens rather than at mount: `repos` arrives with the first
  // snapshot, which lands well after this component first renders, and the selection in the
  // list can change between openings.
  useEffect(() => {
    if (!open) return;
    const preferred = repos.find((r) => r.repoPath === defaultRepoPath);
    // With a single repo there is nothing to choose, so choose it.
    const only = repos.length === 1 ? repos[0] : undefined;
    const next = preferred ?? only;
    if (next) setRepoPath(next.repoPath);
  }, [open, defaultRepoPath, repos]);

  const selected = repos.find((r) => r.repoPath === repoPath) ?? repos[0];
  const branchName = branch.trim();
  const canSubmit = Boolean(selected) && branchName.length > 0 && !starting;

  async function handleCreate() {
    if (!selected || !canSubmit) return;
    setStarting(true);
    try {
      await onCreate(selected.repoPath, branchName);
      // Closing immediately is the point: the terminal tab now owns the run, including any
      // approval prompt worktrunk decides to ask.
      setBranch("");
      onOpenChange(false);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            Runs <code className="font-mono">git-wt switch --create</code> in a terminal tab, so
            you can answer any prompts it raises.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-worktree-repo">Repo</Label>
            <Select value={selected?.repoPath ?? ""} onValueChange={setRepoPath}>
              <SelectTrigger id="new-worktree-repo">
                <SelectValue placeholder="Choose a repository" />
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.repoPath} value={r.repoPath}>
                    {r.repo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-worktree-branch">Branch name</Label>
            <Input
              id="new-worktree-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void handleCreate();
              }}
              placeholder="feat/my-change"
              className="font-mono text-[13px]"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleCreate()}>
            {starting ? "Starting…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
