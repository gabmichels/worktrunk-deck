/**
 * Loads a worktree's commit history a page at a time for the card's expanded state.
 *
 * State lives here (not in `WorktreeCard`) so collapsing the card and re-expanding it is free —
 * `WorktreeCard` only mounts/unmounts the `<CommitList>` presentation, this hook's state
 * persists across that as long as the card component itself stays mounted (it does; expansion
 * is a boolean, not a conditional render of the hook's owner).
 */
import { useCallback, useState } from "react";

import { listCommits } from "@/lib/ipc";
import type { Commit } from "@/lib/types";

const PAGE_SIZE = 10;

export interface UseCommits {
  commits: Commit[];
  loading: boolean;
  /** Set once any page fails — a shallow clone or a repo with no history must not throw (REQ). */
  error: string | null;
  /** False once a page comes back shorter than requested — that's the end of history. */
  hasMore: boolean;
  /** No-op if a fetch for this worktree already ran — re-expanding reuses the cached list. */
  ensureLoaded: () => void;
  loadMore: () => void;
}

/** `null` until the first successful call for a path, so `ensureLoaded` can no-op on repeat. */
export function useCommits(worktreePath: string): UseCommits {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (skip: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listCommits(worktreePath, skip, PAGE_SIZE);
        setCommits((prev) => (skip === 0 ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE_SIZE);
        setLoadedFor(worktreePath);
      } catch (e) {
        // A brand-new repo (no commits) or a shallow clone (log runs dry) should read as an
        // empty/short history, not an error — but genuine backend failures still need a message
        // instead of a silently blank list.
        setError(e instanceof Error ? e.message : String(e));
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [worktreePath],
  );

  const ensureLoaded = useCallback(() => {
    if (loadedFor === worktreePath) return; // already cached — instant re-expand
    void fetchPage(0);
  }, [loadedFor, worktreePath, fetchPage]);

  const loadMore = useCallback(() => {
    void fetchPage(commits.length);
  }, [fetchPage, commits.length]);

  return { commits, loading, error, hasMore, ensureLoaded, loadMore };
}
