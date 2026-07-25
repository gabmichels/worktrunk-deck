/**
 * "3 days ago"-style formatter for commit timestamps in the expanded card (REQ from
 * WorktreeCard's commit history task). No date library — the format needed is a single coarse
 * bucket, not full i18n-correct relative dates.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * `timestamp` is Unix seconds (as `Commit.timestamp` arrives from git, per `types.ts`).
 * `now` is injectable so tests don't race the clock.
 */
export function relativeTime(timestamp: number, now: number = Date.now() / 1000): string {
  const diff = Math.floor(now - timestamp);

  if (diff < 0) return "just now"; // clock skew between machines — don't show "in the future"
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return plural(Math.floor(diff / HOUR), "hour");
  if (diff < WEEK) return plural(Math.floor(diff / DAY), "day");
  if (diff < MONTH) return plural(Math.floor(diff / WEEK), "week");
  if (diff < YEAR) return plural(Math.floor(diff / MONTH), "month");
  return plural(Math.floor(diff / YEAR), "year");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
