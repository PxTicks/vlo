import { describe, it, expect } from "vitest";

/**
 * Ratchet guard for the frame-grid / media-time refactor (Part A/B).
 *
 * Raw `* TICKS_PER_SECOND` / `/ TICKS_PER_SECOND` arithmetic is the scattered
 * pattern we centralized. Each conversion has a boundary module (the CENTRAL
 * list below): tick<->frame in `frameGrid`, tick<->media-seconds in `mediaTime`,
 * tick<->pixel in `pixelGrid`. New code must go through those modules.
 *
 * The migration is complete: every tick conversion now goes through a boundary
 * module. The allowlist is down to its irreducible core — a single file,
 * `timeCalculation`, which sits BELOW mediaTime in the dependency graph
 * (mediaTime imports `calculateClipTime` from it) and so cannot route through
 * mediaTime without an import cycle.
 *
 * Do NOT add entries without cause — prefer migrating to a boundary module.
 * A new file appearing here means raw conversion crept back in.
 */

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Central modules: the canonical home for the conversions (always allowed).
const CENTRAL = [
  "core/time/frameGrid.ts",
  "core/time/pixelGrid.ts",
  "core/time/constants.ts",
  "features/renderer/utils/mediaTime.ts",
];

// Legitimately-exempt non-boundary files:
// - `timeCalculation` sits BELOW mediaTime in the dependency graph (mediaTime
//   imports calculateClipTime from it), so it cannot route through mediaTime
//   without an import cycle.
// - `timeline/constants` defines the single `ADJUSTMENT_DEFAULT_DURATION_TICKS`
//   duration constant (3s in ticks), deliberately timeline-owned and derived
//   from the core time base — a named compile-time constant, not scattered
//   conversion logic, and not worth routing through a boundary module.
// Every other tick conversion goes through a boundary module (frameGrid /
// mediaTime / pixelGrid). Subset-checked: a NEW file doing raw conversion fails.
const ALLOWLIST = [
  "features/transformations/utils/timeCalculation.ts",
  "features/timeline/constants.ts",
];

const RAW_CONVERSION =
  /\*\s*TICKS_PER_SECOND|\/\s*TICKS_PER_SECOND|TICKS_PER_SECOND\s*\*|TICKS_PER_SECOND\s*\//;

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``") // template strings
    .replace(/"(?:\\.|[^"\\])*"/g, '""') // double-quoted strings
    .replace(/'(?:\\.|[^'\\])*'/g, "''"); // single-quoted strings
}

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

describe("tick<->time conversion guard", () => {
  it("has no raw TICKS_PER_SECOND arithmetic outside the central modules + allowlist", () => {
    const allowed = new Set([...CENTRAL, ...ALLOWLIST]);
    const offenders: string[] = [];

    for (const [globKey, source] of Object.entries(RAW_FILES)) {
      const path = normalize(globKey);
      if (path.includes("__tests__") || path.includes(".test.")) continue;
      if (allowed.has(path)) continue;
      if (RAW_CONVERSION.test(stripCommentsAndStrings(source))) {
        offenders.push(path);
      }
    }

    expect(
      offenders,
      `Raw TICKS_PER_SECOND conversion found outside the central modules. Use a ` +
        `boundary module — frameGrid (tick<->frame), mediaTime (tick<->seconds), ` +
        `or pixelGrid (tick<->px) — instead:\n` +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });
});
