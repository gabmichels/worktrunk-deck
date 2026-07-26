import { cn } from "@/lib/utils";

export type DotTone = "ok" | "untracked" | "dirty" | "live" | "idle" | "error";

const TONE_CLASS: Record<DotTone, string> = {
  ok: "bg-[var(--ok)]",
  // Distinct from both clean and dirty: something is here, but nothing committed was touched.
  untracked: "bg-[var(--muted-foreground)]",
  dirty: "bg-[var(--warn)]",
  live: "bg-[var(--live)]",
  idle: "bg-muted-foreground/40",
  error: "bg-destructive",
};

/**
 * The one dot component in the app, so the legend in `HelpModal` can be exhaustive by
 * construction (REQ-14). Live dots pulse; everything else is static.
 */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: DotTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        TONE_CLASS[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}
