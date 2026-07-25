/**
 * Compact filter row (REQ-10): a repo multi-select next to a small text filter, rather than the
 * old full-width text input — most of that width went unused for anything but the placeholder.
 */
import { ChevronDown, Search, X } from "lucide-react";

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

  const toggleRepo = (repoPath: string) => {
    if (allSelected) {
      // From "all", unchecking one means "all except this one" — the user is narrowing, not
      // starting over. Checking from "all" is a no-op, so only the uncheck path matters.
      onSelectedRepoPathsChange(
        repos.map((r) => r.repoPath).filter((p) => p !== repoPath),
      );
      return;
    }
    const next = selectedSet.has(repoPath)
      ? (selectedRepoPaths ?? []).filter((p) => p !== repoPath)
      : [...(selectedRepoPaths ?? []), repoPath];
    // Ticking every repo collapses back to "all", so repos added later still appear.
    onSelectedRepoPathsChange(next.length === repos.length ? null : next);
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
        <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
          <div className="flex items-center gap-2 px-2 py-1">
            <button
              type="button"
              className="text-primary text-[11px] hover:underline disabled:opacity-50"
              onClick={() => onSelectedRepoPathsChange(null)}
              disabled={allSelected}
            >
              Select all
            </button>
            <span className="text-muted-foreground text-[11px]">·</span>
            <button
              type="button"
              className="text-primary text-[11px] hover:underline disabled:opacity-50"
              onClick={() => onSelectedRepoPathsChange([])}
              disabled={selectedCount === 0}
            >
              Deselect all
            </button>
          </div>
          <DropdownMenuSeparator />
          {repos.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-[11px]">
              No repositories configured.
            </p>
          ) : (
            repos.map((r) => (
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
