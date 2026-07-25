import { describe, expect, it } from "vitest";

import { relativeTime } from "./relativeTime";

// Fixed "now" so every case is deterministic regardless of when the suite runs.
const NOW = 1_800_000_000;

describe("relativeTime", () => {
  it("treats sub-minute gaps as just now", () => {
    expect(relativeTime(NOW - 10, NOW)).toBe("just now");
  });

  it("treats future timestamps (clock skew) as just now", () => {
    expect(relativeTime(NOW + 500, NOW)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(relativeTime(NOW - 5 * 60, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - 60, NOW)).toBe("1 minute ago");
  });

  it("formats hours", () => {
    expect(relativeTime(NOW - 3 * 3600, NOW)).toBe("3 hours ago");
    expect(relativeTime(NOW - 3600, NOW)).toBe("1 hour ago");
  });

  it("formats days", () => {
    expect(relativeTime(NOW - 3 * 86400, NOW)).toBe("3 days ago");
    expect(relativeTime(NOW - 86400, NOW)).toBe("1 day ago");
  });

  it("formats weeks", () => {
    expect(relativeTime(NOW - 14 * 86400, NOW)).toBe("2 weeks ago");
  });

  it("formats months", () => {
    expect(relativeTime(NOW - 90 * 86400, NOW)).toBe("3 months ago");
  });

  it("formats years", () => {
    expect(relativeTime(NOW - 400 * 86400, NOW)).toBe("1 year ago");
  });
});
