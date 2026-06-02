import { describe, it, expect } from "vitest";

/**
 * Ratchet guard for the frame-grid / media-time refactor (Part A/B).
 *
 * Raw `* TICKS_PER_SECOND` / `/ TICKS_PER_SECOND` arithmetic is the scattered
 * pattern we centralized: tick<->frame math belongs in `frameGrid`, tick<->media
 * seconds in `mediaTime`. New code must go through those modules.
 *
 * The allowlist freezes the files that still convert raw as of Part B landing:
 *   - pixel-domain (tick <-> px / zoom) — a deliberately separate domain;
 *   - foundational time math that sits BELOW mediaTime in the dep graph and so
 *     cannot import it without a cycle (timeCalculation);
 *   - seconds-sized threshold constants / lookahead windows;
 *   - cold display-seconds + default-duration seeds pending the optional B3.
 *
 * Do NOT add entries without cause — prefer migrating to frameGrid/mediaTime.
 * A new file appearing here means raw conversion crept back in.
 */

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Central modules: the canonical home for the conversions (always allowed).
const CENTRAL = [
  "features/timeline/utils/frameGrid.ts",
  "features/renderer/utils/mediaTime.ts",
  "features/timeline/utils/pixelGrid.ts",
  "features/timeline/constants.ts",
];

// Grandfathered raw-conversion sites (see header). Subset-checked, so removing
// usage from a listed file never fails the guard; only a NEW offending file does.
const ALLOWLIST = [
  // pixel-domain (tick <-> px / zoom) — inline math not yet moved to pixelGrid.
  // The media-heavy hooks (useThumbnailRenderer/useWaveformRenderer) and the
  // canonical view store now route through pixelGrid and are intentionally NOT
  // here, so the guard fully covers them.
  "features/timeline/TimelineContainer.tsx",
  "features/timeline/components/TimelineClip.tsx",
  "features/timeline/components/TimelineClipOverlayLayer.tsx",
  "features/timeline/components/TimelinePlayhead.tsx",
  "features/timeline/components/SelectionOverlay.tsx",
  "features/timeline/hooks/useClipCanvasWindow.ts",
  "features/timeline/utils/snapDragOverlay.ts",
  // foundational time math (below mediaTime in the dep graph)
  "features/transformations/utils/timeCalculation.ts",
  // seconds-sized threshold constants / hot lookahead windows
  "features/renderer/services/TrackRenderEngine.ts",
  "features/player/Player.tsx",
  "features/player/hooks/interaction/useMaskInteractionController.ts",
  // cold display-seconds + default-duration seeds (optional Part B3)
  "features/transformations/utils/layerDomain.ts",
  "features/text/utils/createTextClip.ts",
  "features/miniEditor/MiniEditorModal.tsx",
  "features/miniEditor/useMiniEditorStore.ts",
  "features/generation/hooks/useGenerationPanel.ts",
  "features/generation/utils/inputMetadata.ts",
  "features/generation/utils/inputSelection.ts",
  "features/generation/utils/miniEditorEdit.ts",
  "features/masks/components/MaskActiveRangeSection.tsx",
  "features/masks/components/RangeMaskSection.tsx",
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
      `Raw tick<->seconds conversion found outside the central modules. ` +
        `Use frameGrid (tick<->frame) or mediaTime (tick<->seconds) instead:\n` +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });
});
