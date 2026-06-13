import { describe, expect, it } from "vitest";

/**
 * Ratchet guard for the timeline API migration.
 *
 * `useTimelineStore` is still widely consumed outside `features/timeline`, but
 * new cross-feature store imports should go through `features/timeline/api`.
 * When an allowlisted file is migrated, remove it from this list in the same
 * change. Adding to this list should be treated as boundary debt.
 */

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALLOWLIST = [
  "features/composite/CompositeBrowser.tsx",
  "features/composite/services/groupSelectionIntoComposite.ts",
  "features/composite/useCompositeLibraryStore.ts",
  "features/composite/useCompositeTimelineStore.ts",
  "features/masks/hooks/useMaskPanel.ts",
  "features/masks/hooks/useRangeMaskSelection.ts",
  "features/masks/hooks/useSam2MaskPanel.ts",
  "features/masks/runtime/brushAssetSync.ts",
  "features/player/Player.tsx",
  "features/player/hooks/interaction/useCanvasSelectionKeyboard.ts",
  "features/player/hooks/interaction/useCanvasSelectionManager.ts",
  "features/player/hooks/interaction/useMaskInteractionController.ts",
  "features/player/hooks/interaction/useTransformInteractionController.ts",
  "features/player/hooks/useRenderGroupOrchestrator.ts",
  "features/samAudio/components/SamAudioExtractDialog.tsx",
  "features/samAudio/services/extractionTimelinePlacement.ts",
  "features/samAudio/services/runSamAudioSeparation.ts",
  "features/text/TextPanel.tsx",
  "features/text/utils/insertTextClipAtPlayhead.ts",
  "features/transformations/components/AdjustmentDepthSection.tsx",
  "features/transformations/hooks/useGroupKeyframeManager.ts",
  "features/transformations/hooks/useTimelineKeyframeClipOverlay.tsx",
  "features/transformations/hooks/useTransformationController.ts",
  "features/userAssets/AssetBrowser.tsx",
  "features/userAssets/hooks/useTimelineAssetRevealClipOverlay.tsx",
];

const TIMELINE_STORE_IMPORT =
  /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\buseTimelineStore\b[\s\S]*?\sfrom\s*["'][^"']+["']/;

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function isProductionSource(path: string): boolean {
  return !path.includes("__tests__") && !path.includes(".test.");
}

function isOutsideTimelineFeature(path: string): boolean {
  return !path.startsWith("features/timeline/");
}

function importsTimelineStore(source: string): boolean {
  return TIMELINE_STORE_IMPORT.test(stripComments(source));
}

describe("timeline store boundary guard", () => {
  it("does not add new useTimelineStore imports outside the timeline feature", () => {
    const allowed = new Set(ALLOWLIST);
    const currentImporters = new Set<string>();

    for (const [globKey, source] of Object.entries(RAW_FILES)) {
      const path = normalize(globKey);
      if (!isProductionSource(path)) continue;
      if (!isOutsideTimelineFeature(path)) continue;
      if (importsTimelineStore(source)) {
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
      `New cross-feature useTimelineStore imports found. Add/extend a ` +
        `timeline/api helper instead, or migrate the caller:\n` +
        newImporters.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);

    expect(
      staleAllowlistEntries,
      `Timeline store allowlist contains files that no longer import ` +
        `useTimelineStore. Remove them from the guard:\n` +
        staleAllowlistEntries.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);
  });
});
