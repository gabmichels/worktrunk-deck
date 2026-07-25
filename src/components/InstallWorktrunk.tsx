/**
 * Install instructions for worktrunk, shown when `git-wt` cannot be found.
 *
 * worktrunk is a hard runtime requirement and the deck deliberately does not bundle it (see
 * README "Requirements"): it is a separate project on its own release cadence, and shipping a
 * copy would pin users to whatever version we vendored. The honest alternative is to detect its
 * absence and make installing it a copy-paste — which is what this panel is for.
 */
import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import * as ipc from "@/lib/ipc";

interface InstallOption {
  label: string;
  command: string;
}

/**
 * Commands are taken verbatim from worktrunk.dev. Each includes the shell-integration step,
 * because without it `git-wt switch` cannot change directory — a confusing half-working state
 * that would otherwise land on the user later.
 */
const BY_PLATFORM: Record<string, InstallOption[]> = {
  windows: [
    {
      label: "winget",
      command: "winget install max-sixty.worktrunk\ngit-wt config shell install",
    },
    {
      label: "cargo",
      command: "cargo install worktrunk\ngit-wt config shell install",
    },
  ],
  macos: [
    { label: "Homebrew", command: "brew install worktrunk && wt config shell install" },
    { label: "cargo", command: "cargo install worktrunk && wt config shell install" },
  ],
  linux: [
    { label: "Homebrew", command: "brew install worktrunk && wt config shell install" },
    { label: "cargo", command: "cargo install worktrunk && wt config shell install" },
    { label: "Arch", command: "sudo pacman -S worktrunk && wt config shell install" },
    {
      label: "conda-forge",
      command: "conda install -c conda-forge worktrunk && wt config shell install",
    },
  ],
};

export function InstallWorktrunk() {
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc
      .hostPlatform()
      .then((p) => alive && setPlatform(p))
      .catch(() => alive && setPlatform("linux"));
    return () => {
      alive = false;
    };
  }, []);

  const options = BY_PLATFORM[platform ?? ""] ?? BY_PLATFORM.linux!;

  return (
    <div className="border-border bg-background space-y-2 rounded-md border p-2">
      <p className="text-muted-foreground text-[11px]">
        worktrunk is a separate tool the deck drives. Install it, then re-check below.
      </p>

      <div className="space-y-1.5">
        {options.map((option) => (
          <CommandRow key={option.label} option={option} />
        ))}
      </div>

      <a
        href="https://worktrunk.dev"
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary inline-flex items-center gap-1 text-[11px] hover:underline"
      >
        worktrunk.dev
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </div>
  );
}

function CommandRow({ option }: { option: InstallOption }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(option.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable; the command is on screen and selectable regardless.
    }
  }

  return (
    <div className="flex items-start gap-1.5">
      <span className="text-muted-foreground w-16 shrink-0 pt-1 text-[11px]">{option.label}</span>
      <pre className="border-border bg-card min-w-0 flex-1 overflow-x-auto rounded border px-2 py-1 font-mono text-[11px]">
        {option.command}
      </pre>
      <Button
        variant="outline"
        size="icon-sm"
        className="size-6 shrink-0"
        onClick={() => void copy()}
        aria-label={`Copy the ${option.label} install command`}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </div>
  );
}
