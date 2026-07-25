/**
 * A thin indeterminate progress bar pinned to the top of the window, plus the current label.
 *
 * Indeterminate rather than a percentage: none of the tracked operations can report real
 * progress (worktrunk does not stream a completion count), and a fake percentage would be a
 * lie. Deliberately unobtrusive — it must not shift the layout when it appears, so it is
 * absolutely positioned rather than inserted into the flow.
 */
import { useBusy } from "@/hooks/useBusy";
import { cn } from "@/lib/utils";

export function BusyBar() {
  const { busy, label } = useBusy();

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-50"
      role="status"
      aria-live="polite"
      aria-busy={busy}
    >
      <div className={cn("h-0.5 w-full overflow-hidden", !busy && "opacity-0")}>
        <div className="bg-primary animate-indeterminate h-full w-1/3 rounded-full" />
      </div>

      {busy && label && (
        <div className="flex justify-center">
          <span className="bg-card border-border text-muted-foreground mt-1 rounded-full border px-2 py-0.5 text-[11px] shadow-sm">
            {label}
          </span>
        </div>
      )}
    </div>
  );
}
