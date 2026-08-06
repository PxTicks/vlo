import { describe, expect, it } from "vitest";

/**
 * Mediabunny track `computeDuration()` returns an end timestamp. Direct calls
 * make it too easy to publish or calculate with that value as though it were a
 * span, so track metadata must pass through the core timestamp-range helper.
 */
const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const DIRECT_TRACK_DURATION =
  /\b(?:audioTrack|videoTrack|track)\.computeDuration\s*\(/;

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe("media timestamp range boundary", () => {
  it("routes decoder track duration reads through core/time", () => {
    const offenders = Object.entries(RAW_FILES).flatMap(([globKey, source]) => {
      const path = normalize(globKey);
      if (path.includes("__tests__") || path.includes(".test.")) return [];
      return DIRECT_TRACK_DURATION.test(stripCommentsAndStrings(source))
        ? [path]
        : [];
    });

    expect(
      offenders,
      "Direct decoder track computeDuration() call found. Use " +
        "readMediaTimestampRange() so end timestamps and spans stay distinct.",
    ).toEqual([]);
  });
});
