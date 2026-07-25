import { TooltipProvider } from "@radix-ui/react-tooltip";
import { RefreshCw } from "lucide-react";

import { RepoSection } from "@/components/RepoSection";
import { Button } from "@/components/ui/button";
import { ConfigProvider, useConfig } from "@/hooks/useConfig";
import { useTheme } from "@/hooks/useTheme";
import { useWorktrees } from "@/hooks/useWorktrees";

export default function App() {
  return (
    <ConfigProvider>
      <TooltipProvider delayDuration={300}>
        <Deck />
      </TooltipProvider>
    </ConfigProvider>
  );
}

function Deck() {
  const { config, loaded, gitWt } = useConfig();
  useTheme(config.theme);

  const hasRepos = config.repos.length > 0 || !!config.scanRoot;
  const ready = loaded && hasRepos && gitWt?.ok === true;

  const { snapshot, isStale, isLoading, error, refresh } = useWorktrees(
    config.autoRefreshMs,
    ready,
  );

  if (!loaded) return <Centered>Loading…</Centered>;
  if (!ready) {
    return (
      <Centered>
        <div className="max-w-md space-y-2 text-center">
          <p className="text-sm font-medium">Not set up yet</p>
          <p className="text-muted-foreground text-xs">
            {gitWt && !gitWt.ok
              ? gitWt.error
              : "No repositories are configured yet."}
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-border flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">worktrunk-deck</h1>
        <span className="text-muted-foreground text-xs">
          {snapshot ? `${snapshot.runningCount} running` : "…"}
        </span>
        <div className="flex-1" />
        {isStale && (
          <span className="text-[var(--warn)] text-xs" role="status">
            stale — {error}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="size-3.5" aria-hidden />
          Refresh
        </Button>
      </header>

      <main className="flex-1 space-y-5 overflow-y-auto p-4">
        {isLoading && !snapshot ? (
          <Centered>Loading worktrees…</Centered>
        ) : (
          snapshot?.repos.map((repo) => (
            <RepoSection key={repo.repoPath} repo={repo} worktrees={repo.worktrees} />
          ))
        )}
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
      {children}
    </div>
  );
}
