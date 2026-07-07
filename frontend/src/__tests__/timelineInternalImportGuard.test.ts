import { describe, expect, it } from "vitest";

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PUBLIC_TIMELINE_TARGETS = new Set([
  "features/timeline",
  "features/timeline/api",
  "features/timeline/clipOverlayApi",
  "features/timeline/constants",
]);

const LEGACY_INTERNAL_ALLOWLIST = [
  "features/composite/CompositeBrowser.tsx -> features/timeline/hooks/useInteractionStore",
  "features/renderer/services/AdjustmentEffectResolver.ts -> features/timeline/utils/clipPresentation",
  "features/renderer/services/ExportRenderer.ts -> features/timeline/utils/clipPresentation",
  "features/renderer/utils/clipLookup.ts -> features/timeline/utils/clipPresentation",
  "features/samAudio/components/SamAudioExtractDialog.tsx -> features/timeline/utils/clipAudioExtraction",
  "features/timelineSelection/utils/composite.ts -> features/timeline/utils/clipPresentation",
  "features/transitions/components/TransitionDragOverlay.tsx -> features/timeline/hooks/useInteractionStore",
  "features/transitions/components/TransitionOverlay.tsx -> features/timeline/model/transitionModel",
  "features/transitions/components/TransitionOverlay.tsx -> features/timeline/utils/timelineGeometry",
  "features/transitions/hooks/useTransitionDrag.ts -> features/timeline/hooks/dnd/usePointerTracker",
  "features/transitions/hooks/useTransitionDrag.ts -> features/timeline/hooks/useInteractionStore",
  "features/transitions/hooks/useTransitionDrag.ts -> features/timeline/hooks/useTimelineViewStore",
  "features/transitions/hooks/useTransitionDrag.ts -> features/timeline/model/transitionModel",
  "features/transitions/hooks/useTransitionDrag.ts -> features/timeline/utils/clipPresentation",
  "features/transitions/rendering/TransitionResolver.ts -> features/timeline/model/transitionModel",
  "features/transformations/components/TransformationDragOverlay.tsx -> features/timeline/hooks/useInteractionStore",
  "features/transformations/hooks/useTimelineKeyframeClipOverlay.tsx -> features/timeline/hooks/useTimelineViewStore",
  "features/transformations/hooks/useTimelineKeyframeClipOverlay.tsx -> features/timeline/utils/snapDragOverlay",
  "features/transformations/hooks/useTransformDrag.ts -> features/timeline/hooks/dnd/dropGeometry",
  "features/transformations/hooks/useTransformDrag.ts -> features/timeline/hooks/dnd/usePointerTracker",
  "features/transformations/hooks/useTransformDrag.ts -> features/timeline/hooks/useInteractionStore",
  "features/transformations/hooks/useTransformDrag.ts -> features/timeline/hooks/useTimelineViewStore",
  "features/transformations/hooks/useTransformationController.ts -> features/timeline/utils/clipPresentation",
  "features/transformations/utils/clipTimeDomains.ts -> features/timeline/utils/clipPresentation",
  "features/transformations/utils/findClipAtPoint.ts -> features/timeline/utils/clipPresentation",
  "features/userAssets/AssetBrowser.tsx -> features/timeline/hooks/useInteractionStore",
];

const IMPORT_SOURCE =
  /(?:import\s+[\s\S]*?\sfrom\s*|export\s+[\s\S]*?\sfrom\s*|import\s*\()\s*["']([^"']+)["']/g;

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

function resolveImport(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const parts = importerPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function timelineImportEdges(path: string, source: string): string[] {
  const edges: string[] = [];
  for (const match of stripComments(source).matchAll(IMPORT_SOURCE)) {
    const resolved = resolveImport(path, match[1]);
    if (
      resolved !== "features/timeline" &&
      !resolved?.startsWith("features/timeline/")
    ) {
      continue;
    }
    if (PUBLIC_TIMELINE_TARGETS.has(resolved)) continue;
    edges.push(`${path} -> ${resolved}`);
  }
  return edges;
}

describe("timeline internal import guard", () => {
  it("keeps non-timeline features on approved public timeline surfaces", () => {
    const allowed = new Set(LEGACY_INTERNAL_ALLOWLIST);
    const currentEdges = new Set<string>();

    for (const [globKey, source] of Object.entries(RAW_FILES)) {
      const path = normalize(globKey);
      if (!isProductionSource(path)) continue;
      if (!isOutsideTimelineFeature(path)) continue;
      timelineImportEdges(path, source).forEach((edge) =>
        currentEdges.add(edge),
      );
    }

    const newEdges = [...currentEdges]
      .filter((edge) => !allowed.has(edge))
      .sort();
    const staleAllowlistEntries = LEGACY_INTERNAL_ALLOWLIST.filter(
      (edge) => !currentEdges.has(edge),
    ).sort();

    expect(
      newEdges,
      `New timeline-internal imports found. Add or extend a public timeline ` +
        `surface instead:\n${newEdges.map((edge) => `  - ${edge}`).join("\n")}`,
    ).toEqual([]);

    expect(
      staleAllowlistEntries,
      `Timeline internal import allowlist has stale entries. Remove them:\n` +
        staleAllowlistEntries.map((edge) => `  - ${edge}`).join("\n"),
    ).toEqual([]);
  });
});
