/**
 * "New worktree" modal: pick a repo, name a branch, delegate to `git-wt switch --create` (REQ-5).
 * Progress streams inline via the shared `CliLogPanel` so the user isn't staring at a blank
 * dialog for however long the checkout/setup hooks take.
 */
import { useEffect, useRef, useState } from "react";

import { CliLogPanel } from "@/components/CliLogPanel";
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
import type { UseCliRun } from "@/hooks/useCliRun";
import * as ipc from "@/lib/ipc";

export function NewWorktreeModal({
  open,
  onOpenChange,
  repos,
  run,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  repos: { repo: string; repoPath: string }[];
  run: UseCliRun;
  onCreated: () => void;
}) {
  const [repoPath, setRepoPath] = useState<string>(repos[0]?.repoPath ?? "");
  const [branch, setBranch] = useState("");

  const selected = repos.find((r) => r.repoPath === repoPath) ?? repos[0];
  const canSubmit = Boolean(selected) && branch.trim().length > 0 && !run.running;

  async function handleCreate() {
    if (!selected) return;
    const branchName = branch.trim();
    await run.start(`Create worktree ${branchName}`, () =>
      ipc.createWorktree(selected.repoPath, branchName),
    );
  }

  // Success is inferred from the streamed exit code rather than the resolved promise of
  // `start()`, since `createWorktree()` only resolves once the child is spawned, not once it
  // finishes (plan §3.4). Guarded by a ref so a single successful run only refreshes once.
  const notifiedCreatedRef = useRef(false);
  useEffect(() => {
    if (run.runId !== null || run.running) notifiedCreatedRef.current = false;
  }, [run.runId, run.running]);
  useEffect(() => {
    if (open && run.exitCode === 0 && !notifiedCreatedRef.current) {
      notifiedCreatedRef.current = true;
      onCreated();
    }
  }, [open, run.exitCode, onCreated]);

  function handleOpenChange(o: boolean) {
    if (!o && run.running) return; // don't let the user close mid-stream and lose the run
    if (!o) run.clear();
    if (!o) setBranch("");
    onOpenChange(o);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            Creates a worktree via <code className="font-mono">git-wt switch --create</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-worktree-repo">Repo</Label>
            <Select
              value={repoPath}
              onValueChange={setRepoPath}
              disabled={run.running || repos.length === 0}
            >
              <SelectTrigger id="new-worktree-repo">
                <SelectValue placeholder="Select a repo" />
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
              placeholder="feat/my-branch"
              className="font-mono"
              value={branch}
              disabled={run.running}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void handleCreate();
              }}
              autoFocus
            />
          </div>

          <CliLogPanel run={run} onClose={() => run.clear()} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={run.running}>
            {run.exitCode === 0 ? "Close" : "Cancel"}
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canSubmit}>
            {run.running ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
