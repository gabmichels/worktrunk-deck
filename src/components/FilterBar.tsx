/**
 * Compact filter row (REQ-10): a repo multi-select next to a small text filter, rather than the
 * old full-width text input — most of that width went unused for anything but the placeholder.
 */
import { ChevronDown, Search, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { repoAccentStyle } from "@/lib/repoColor";

export interface RepoChoice {
  repo: string;
  repoPath: string;
  count: number;
}

/**
 * `null` means "every repo, including ones discovered later" — distinct from an array that
 * happens to list them all today, which would silently hide a repo added tomorrow. `[]` means
 * none. Modelling it this way avoids needing a sentinel value inside the array.
 */
export type RepoSelection = string[] | null;

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function FilterBar({
  value,
  onChange,
  matchCount,
  totalCount,
  repos,
  selectedRepoPaths,
  onSelectedRepoPathsChange,
}: {
  value: string;
  onChange: (next: string) => void;
  matchCount: number;
  totalCount: number;
  repos: RepoChoice[];
  selectedRepoPaths: RepoSelection;
  onSelectedRepoPathsChange: (next: RepoSelection) => void;
}) {
  const allSelected = selectedRepoPaths === null;
  const selectedSet = new Set(selectedRepoPaths ?? []);

  // A workspace can hold dozens of repos, which is more than is comfortable to scan by eye —
  // so the menu gets its own search, independent of the worktree filter beside it.
  const [repoQuery, setRepoQuery] = useState("");
  const shownRepos = repoQuery.trim()
    ? repos.filter((r) => {
        const q = repoQuery.trim().toLowerCase();
        return r.repo.toLowerCase().includes(q) || r.repoPath.toLowerCase().includes(q);
      })
    : repos;

  /** Collapses a complete list back to `null` so repos added later stay visible. */
  const commit = (next: string[]) =>
    onSelectedRepoPathsChange(next.length === repos.length ? null : next);

  const toggleRepo = (repoPath: string) => {
    if (allSelected) {
      // From "all", unchecking one means "all except this one" — the user is narrowing, not
      // starting over. Checking from "all" is a no-op, so only the uncheck path matters.
      onSelectedRepoPathsChange(
        repos.map((r) => r.repoPath).filter((p) => p !== repoPath),
      );
      return;
    }
    commit(
      selectedSet.has(repoPath)
        ? (selectedRepoPaths ?? []).filter((p) => p !== repoPath)
        : [...(selectedRepoPaths ?? []), repoPath],
    );
  };

  const selectedCount = allSelected ? repos.length : selectedSet.size;
  const triggerLabel = allSelected
    ? "All repositories"
    : selectedCount === 0
      ? "No repositories"
      : `${selectedCount} of ${repos.length} repositories`;

  return (
    <div className="border-border bg-background flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-[12px] font-normal"
            aria-label="Filter by repository"
          >
            {triggerLabel}
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="flex max-h-96 w-72 flex-col">
          <div className="border-border flex items-center gap-1.5 border-b px-2 pb-1.5">
            <Search className="text-muted-foreground size-3 shrink-0" aria-hidden />
            <input
              value={repoQuery}
              onChange={(e) => setRepoQuery(e.target.value)}
              // Radix menus consume keystrokes for typeahead, which would swallow everything
              // typed here and jump focus between items instead.
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search repositories…"
              aria-label="Search repositories"
              className="placeholder:text-muted-foreground h-6 w-full bg-transparent text-[12px] outline-none"
              autoFocus
            />
            {repoQuery && (
              <button
                type="button"
                onClick={() => setRepoQuery("")}
                aria-label="Clear repository search"
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 px-2 py-1">
            <button
              type="button"
              className="text-primary text-[11px] hover:underline disabled:opacity-50"
              // With a search active these act on what is visible, which is what "select all"
              // means when you have just narrowed the list.
              onClick={() => {
                if (!repoQuery.trim()) {
                  onSelectedRepoPathsChange(null);
                  return;
                }
                const base = selectedRepoPaths ?? repos.map((r) => r.repoPath);
                commit(unique([...base, ...shownRepos.map((r) => r.repoPath)]));
              }}
              disabled={allSelected && !repoQuery.trim()}
            >
              {repoQuery.trim() ? "Select matching" : "Select all"}
            </button>
            <span className="text-muted-foreground text-[11px]">·</span>
            <button
              type="button"
              className="text-primary text-[11px] hover:underline disabled:opacity-50"
              onClick={() => {
                if (!repoQuery.trim()) {
                  onSelectedRepoPathsChange([]);
                  return;
                }
                const drop = new Set(shownRepos.map((r) => r.repoPath));
                const base = selectedRepoPaths ?? repos.map((r) => r.repoPath);
                commit(base.filter((p) => !drop.has(p)));
              }}
              disabled={selectedCount === 0}
            >
              {repoQuery.trim() ? "Deselect matching" : "Deselect all"}
            </button>
          </div>
          <DropdownMenuSeparator />

          <div className="min-h-0 flex-1 overflow-y-auto">
          {repos.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-[11px]">
              No repositories configured.
            </p>
          ) : shownRepos.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-[11px]">
              No repositories match “{repoQuery}”.
            </p>
          ) : (
            shownRepos.map((r) => (
              <DropdownMenuCheckboxItem
                key={r.repoPath}
                checked={allSelected || selectedSet.has(r.repoPath)}
                // Without this the menu closes on every tick, which makes selecting several
                // repos needlessly tedious.
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => toggleRepo(r.repoPath)}
              >
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={repoAccentStyle(r.repoPath)}
                  aria-hidden
                />
                <span className="truncate font-mono">{r.repo}</span>
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">
                  {r.count}
                </span>
              </DropdownMenuCheckboxItem>
            ))
          )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="border-border bg-card flex h-6 w-48 shrink-0 items-center gap-1.5 rounded-md border px-2">
        <Search className="text-muted-foreground size-3 shrink-0" aria-hidden />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter worktrees"
          className="h-5 border-none bg-transparent px-0 text-[12px] shadow-none focus-visible:outline-none"
        />
        {value && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-4"
            onClick={() => onChange("")}
            aria-label="Clear filter"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>

      <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
        {value ? `${matchCount} / ${totalCount}` : totalCount}
      </span>
    </div>
  );
}
