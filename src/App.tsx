import { TooltipProvider } from "@radix-ui/react-tooltip";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import { Toaster } from "sonner";

import { CliLogPanel } from "@/components/CliLogPanel";
import { FeatureGroup } from "@/components/FeatureGroup";
import { FilterBar, type RepoChoice, type RepoSelection } from "@/components/FilterBar";
import { FirstRunGate } from "@/components/FirstRunGate";
import { Header } from "@/components/Header";
import { HelpModal } from "@/components/HelpModal";
import { IsolatedWorktrees } from "@/components/IsolatedWorktrees";
import { NewWorktreeModal } from "@/components/NewWorktreeModal";
import { RepoSection } from "@/components/RepoSection";
import { SettingsModal } from "@/components/SettingsModal";
import { TerminalSidebar, useTerminalSessions } from "@/components/TerminalSidebar";
import { WorktreeActions } from "@/components/WorktreeActions";
import { useCliRun } from "@/hooks/useCliRun";
import { ConfigProvider, useConfig } from "@/hooks/useConfig";
import { useTheme } from "@/hooks/useTheme";
import { useWorktrees } from "@/hooks/useWorktrees";
import { allWorktrees } from "@/lib/adapter";
import { groupByFeature, isIsolated, matchesFilter } from "@/lib/grouping";
import type { Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function App() {
  return (
    <ConfigProvider>
      <TooltipProvider delayDuration={300}>
        <Deck />
        <Toaster position="bottom-right" closeButton theme="system" />
      </TooltipProvider>
    </ConfigProvider>
  );
}

function Deck() {
  const { config, loaded, gitWt, reload, update } = useConfig();
  useTheme(config.theme);

  // The gate owns setup; the dashboard only renders once there is something to show and a
  // worktrunk binary to show it with (REQ-1, TASK-20).
  const configured = config.repos.length > 0 || !!config.scanRoot;
  const ready = loaded && configured && gitWt?.ok === true;

  const { snapshot, isStale, isLoading, refresh } = useWorktrees(config.autoRefreshMs, ready);

  const [filter, setFilter] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  /** `null` = every repo, including any discovered later (see FilterBar). */
  const [selectedRepos, setSelectedRepos] = useState<RepoSelection>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  const run = useCliRun();
  const terminals = useTerminalSessions();

  const everyWorktree = useMemo(
    () => (snapshot ? allWorktrees(snapshot) : []),
    [snapshot],
  );

  const visible = useMemo(() => {
    const allowed = selectedRepos === null ? null : new Set(selectedRepos);
    return everyWorktree.filter(
      (w) =>
        matchesFilter(w, filter) &&
        (!runningOnly || w.urlActive) &&
        (allowed === null || allowed.has(w.repoPath)),
    );
  }, [everyWorktree, filter, runningOnly, selectedRepos]);

  /** Repo choices for the filter dropdown, with each repo's worktree count. */
  const repoChoices = useMemo<RepoChoice[]>(
    () =>
      (snapshot?.repos ?? []).map((r) => ({
        repo: r.repo,
        repoPath: r.repoPath,
        count: r.worktrees.length,
      })),
    [snapshot],
  );

  /**
   * Switches the scanned folder. Drilling into a single repo is the fast way to escape a
   * cluttered workspace: if the chosen folder is itself a checkout, the backend resolves it to
   * that one repo and worktrunk lists its worktrees (including nested `.claude/worktrees`).
   */
  const setScanRoot = (next: string) => {
    // Any repo-level filter refers to the old folder's repos, so it would silently hide
    // everything in the new one.
    setSelectedRepos(null);
    void update({ scanRoot: next }).then(() => refresh());
  };

  const pickFolder = async () => {
    const chosen = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: config.scanRoot,
    });
    if (typeof chosen === "string") setScanRoot(chosen);
  };

  const parentOf = (p: string): string | null => {
    const trimmed = p.replace(/[/\\]+$/, "");
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (cut <= 0) return null;
    const parent = trimmed.slice(0, cut);
    // `C:` alone is not a usable directory; `C:/` is.
    return /^[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent;
  };

  const parent = config.scanRoot ? parentOf(config.scanRoot) : null;

  /** Hiding is a config change, so it survives restarts (unlike the filter above). */
  const hideRepo = (repoPath: string) => {
    const hidden = config.hiddenRepos ?? [];
    if (hidden.includes(repoPath)) return;
    void update({ hiddenRepos: [...hidden, repoPath] }).then(() => refresh());
  };

  /** Opening a terminal should reveal the sidebar — otherwise the tab appears nowhere. */
  const openTerminal = (w: Worktree) => {
    setTerminalOpen(true);
    void terminals.openTerminal(w);
  };
  const runDev = (w: Worktree) => {
    setTerminalOpen(true);
    void terminals.runDev(w);
  };
  const openTerminalAt = (path: string) => {
    setTerminalOpen(true);
    void terminals.openTerminalAtPath(path);
  };

  const renderActions = (w: Worktree) => (
    <WorktreeActions
      worktree={w}
      run={run}
      onChanged={() => void refresh()}
      onOpenTerminal={openTerminal}
      onRunDev={runDev}
    />
  );

  if (!loaded) return <Centered>Loading…</Centered>;
  if (!ready) return <FirstRunGate onDone={() => void reload()} />;

  const visibleSet = new Set(visible.map(keyOf));
  const features = config.crossRepoGrouping ? groupByFeature(visible) : [];
  const grouped = new Set(features.flatMap((f) => f.worktrees.map(keyOf)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        runningCount={visible.filter((w) => w.urlActive).length}
        totalCount={everyWorktree.length}
        lastUpdated={snapshot?.generatedAt ?? null}
        isStale={isStale}
        runningOnly={runningOnly}
        onToggleRunningOnly={() => setRunningOnly((v) => !v)}
        onRefresh={() => void refresh()}
        onNewWorktree={() => setNewOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        scanRoot={config.scanRoot ?? null}
        onPickFolder={() => void pickFolder()}
        onGoToParent={parent ? () => setScanRoot(parent) : undefined}
      />

      <FilterBar
        value={filter}
        onChange={setFilter}
        matchCount={visible.length}
        totalCount={everyWorktree.length}
        repos={repoChoices}
        selectedRepoPaths={selectedRepos}
        onSelectedRepoPathsChange={setSelectedRepos}
      />

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 space-y-5 overflow-y-auto p-4">
          {isLoading && !snapshot ? (
            <Centered>Loading worktrees…</Centered>
          ) : (
            <>
              {/* Cross-repo grouping is display-only and off by default (REQ-4). */}
              {features.map((f) => (
                <FeatureGroup key={f.feature} feature={f} renderActions={renderActions} />
              ))}

              {snapshot?.repos.map((repo) => {
                // An unreadable repo has no worktrees to filter, but its error must still be
                // visible however the view is filtered (REQ-15).
                const rows = repo.worktrees.filter(
                  (w) => visibleSet.has(keyOf(w)) && !grouped.has(keyOf(w)),
                );
                if (repo.load === "ok" && rows.length === 0) return null;
                return (
                  <RepoSection
                    key={repo.repoPath}
                    repo={repo}
                    worktrees={rows}
                    renderActions={renderActions}
                    onOpenTerminalAt={openTerminalAt}
                    onHideRepo={hideRepo}
                  />
                );
              })}

              {/* Worktrees not part of any tracked feature, so nothing is invisible (REQ-9). */}
              {config.crossRepoGrouping && (
                <IsolatedWorktrees
                  worktrees={visible.filter((w) => isIsolated(w, everyWorktree))}
                  renderActions={renderActions}
                />
              )}

              {visible.length === 0 && snapshot && (
                <Centered>
                  {everyWorktree.length === 0
                    ? "No worktrees found in the configured repositories."
                    : "No worktrees match the current filter."}
                </Centered>
              )}
            </>
          )}
        </main>

        {terminalOpen && (
          <aside
            className={cn(
              "border-border flex w-[46%] min-w-[22rem] flex-col border-l",
              "max-w-[60rem]",
            )}
          >
            <TerminalSidebar
              controller={terminals}
              onCollapse={() => setTerminalOpen(false)}
            />
          </aside>
        )}
      </div>

      <CliLogPanel run={run} onClose={run.clear} />

      <NewWorktreeModal
        open={newOpen}
        onOpenChange={setNewOpen}
        repos={(snapshot?.repos ?? []).map((r) => ({ repo: r.repo, repoPath: r.repoPath }))}
        run={run}
        onCreated={() => void refresh()}
      />
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
      <HelpModal open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/** Repo path + branch uniquely identifies a worktree across the whole deck. */
function keyOf(w: Worktree): string {
  return `${w.repoPath}::${w.branch}`;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center text-sm">
      {children}
    </div>
  );
}
