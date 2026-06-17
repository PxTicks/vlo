import { describe, it, expect } from "vitest";

/**
 * Ratchet guard for the source-frame sync boundary (ratchet step 4).
 *
 * Features that attach work to the exact source frame being rendered (SAM2
 * previews, generated masks, frame-local overlays, cached media-derived
 * results) must resolve that frame identity through `sourceFrameSync`
 * (`SourceFrameSyncRef` / `createSourceFrameSyncRef*` / its `key` + `generation`
 * intent), NOT by re-deriving it from the low-level timing primitives. A private
 * timing path is exactly how the SAM2 stale-preview bug got in: a separate
 * render path made backward scrubbing show stale async completions.
 *
 * So the source-frame-identity primitives below are allowed only inside the
 * renderer/time layer (`features/renderer/`, which owns mediaTime, renderTime,
 * sourceFrameSync, and the render-intent services) and tests. Feature code that
 * imports them is boundary debt and must be allowlisted with a reason.
 *
 *   - calculatePlayerFrameTime          (clip-local source seconds)
 *   - snapFrameTimeSeconds              (source-frame snapping)
 *   - getRenderedSourceFrameReference*  (source-frame identity)
 *
 * Deliberately NOT guarded here: `calculateClipTime` and `playbackClock.time`.
 * Both are listed in the plan, but they have pervasive, legitimate non-frame
 * uses (clip-time for thumbnails/waveforms/presentation; the playhead tick for
 * selection/scrub/overlays). A textual guard cannot separate "source-frame
 * identity" misuse from those, so banning them would be noise, not signal. The
 * named primitives above ARE the irreducible frame-identity boundary: any
 * correct source-frame derivation must pass through them, so guarding them is
 * sufficient to keep feature code on `sourceFrameSync`.
 */

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// The renderer/time layer owns these primitives outright (defines, re-exports,
// wraps them in sourceFrameSync, and owns the render-intent services).
const ALLOWED_PREFIX = "features/renderer/";

// Feature-side exceptions (boundary debt). Each must justify why it resolves a
// source frame WITHOUT going through `sourceFrameSync`.
const ALLOWLIST = [
  // SAM2 canonicalizes individual point ticks onto the rendered source frame
  // (per-point identity for backend grouping), which is a different concern
  // from render-intent gating and predates the shared ref.
  "features/masks/utils/sam2SourceFrame.ts",
  "features/masks/hooks/useSam2MaskPanel.ts",
];

const GUARDED_SYMBOLS = [
  "calculatePlayerFrameTime",
  "snapFrameTimeSeconds",
  "getRenderedSourceFrameReferenceFromSeconds",
  "getRenderedSourceFrameReferenceFromTicks",
];

// Match the symbol only where it is imported, so a same-named local doesn't
// trip the guard and a mere mention in prose doesn't either.
const IMPORT_REGEXES = GUARDED_SYMBOLS.map(
  (symbol) =>
    new RegExp(
      `(?:^|\\n)\\s*import\\b[\\s\\S]*?\\b${symbol}\\b[\\s\\S]*?\\sfrom\\s*["'][^"']+["']`,
    ),
);

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function importsGuardedSymbol(source: string): boolean {
  const stripped = stripComments(source);
  return IMPORT_REGEXES.some((regex) => regex.test(stripped));
}

describe("source-frame sync boundary guard", () => {
  it("only the renderer/time layer (or allowlisted debt) imports the source-frame primitives", () => {
    const allowed = new Set(ALLOWLIST);
    const currentImporters = new Set<string>();

    for (const [globKey, source] of Object.entries(RAW_FILES)) {
      const path = normalize(globKey);
      if (path.includes("__tests__") || path.includes(".test.")) continue;
      if (path.startsWith(ALLOWED_PREFIX)) continue;
      if (importsGuardedSymbol(source)) {
        currentImporters.add(path);
      }
    }

    const newImporters = [...currentImporters]
      .filter((path) => !allowed.has(path))
      .sort();
    const staleAllowlistEntries = ALLOWLIST.filter(
      (path) => !currentImporters.has(path),
    ).sort();

    expect(
      newImporters,
      `New feature code resolves a source frame outside the renderer/time ` +
        `boundary. Route frame identity through 'sourceFrameSync' ` +
        `(createSourceFrameSyncRef / SourceFrameSyncRef + its key/generation ` +
        `intent) instead of calling the timing primitives directly:\n` +
        newImporters.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);

    expect(
      staleAllowlistEntries,
      `Source-frame guard allowlist has entries that no longer import a ` +
        `guarded primitive. Remove them:\n` +
        staleAllowlistEntries.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);
  });
});
