/**
 * Client-side filter over repo / branch / feature (REQ-10). Filtering itself lives in
 * `grouping.ts#matchesFilter`; this component is just the input and the match count.
 */
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function FilterBar({
  value,
  onChange,
  matchCount,
  totalCount,
}: {
  value: string;
  onChange: (next: string) => void;
  matchCount: number;
  totalCount: number;
}) {
  return (
    <div className="border-border bg-background flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <Search className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter by repo, branch, or feature…"
        aria-label="Filter worktrees"
        className="h-6 border-none bg-transparent px-0 text-[12px] shadow-none focus-visible:outline-none"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-5"
          onClick={() => onChange("")}
          aria-label="Clear filter"
        >
          <X className="size-3" />
        </Button>
      )}
      <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
        {value ? `${matchCount} / ${totalCount}` : totalCount}
      </span>
    </div>
  );
}
