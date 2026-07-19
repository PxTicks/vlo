import { describe, expect, it } from "vitest";

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RESTRICTED_PRIMITIVES = new Set([
  "buildTimelineClipPresentationIndex",
  "resolveClipOffsetForPresentationOffset",
  "resolvePresentationOffsetForClipOffset",
  "resolvePresentationTickForClipOffset",
  "resolveStoredEndForPresentationEnd",
  "resolveStoredStartForPresentationStart",
]);

const ALLOWED_EDGES = new Set([
  "features/timeline/TimelineContainer.tsx -> buildTimelineClipPresentationIndex",
  "features/timeline/components/TimelineClipOverlayLayer.tsx -> resolveClipOffsetForPresentationOffset",
  "features/timeline/components/TimelineClipOverlayLayer.tsx -> resolvePresentationOffsetForClipOffset",
  "features/timeline/hooks/dnd/useClipMove.ts -> buildTimelineClipPresentationIndex",
  "features/timeline/hooks/dnd/useClipMove.ts -> resolveStoredStartForPresentationStart",
  "features/timeline/hooks/dnd/useClipResize.ts -> buildTimelineClipPresentationIndex",
  "features/timeline/hooks/dnd/useClipResize.ts -> resolveStoredEndForPresentationEnd",
  "features/timeline/hooks/dnd/useClipResize.ts -> resolveStoredStartForPresentationStart",
  "features/timeline/hooks/useInteractionStore.ts -> buildTimelineClipPresentationIndex",
  "features/timeline/hooks/useInteractionStore.ts -> resolvePresentationOffsetForClipOffset",
  "features/timeline/hooks/useInteractionStore.ts -> resolvePresentationTickForClipOffset",
  "features/timeline/model/transitionModel.ts -> buildTimelineClipPresentationIndex",
  "features/timeline/utils/timelinePlacementMapper.ts -> buildTimelineClipPresentationIndex",
  "features/timeline/utils/timelinePlacementMapper.ts -> resolveStoredStartForPresentationStart",
  "features/transformations/utils/findClipAtPoint.ts -> buildTimelineClipPresentationIndex",
  "features/transitions/hooks/useTransitionDrag.ts -> buildTimelineClipPresentationIndex",
]);

const IMPORT_PATTERN =
  /import\s*\{([^}]*)\}\s*from\s*["']([^"']*clipPresentation)["']/g;

function normalizePath(globPath: string): string {
  return globPath.replace(/^\.\.\//, "");
}

function isProductionSource(path: string): boolean {
  return !path.includes("__tests__") && !path.includes(".test.");
}

describe("timeline placement primitive import guard", () => {
  it("prevents the low-level placement allowlist from growing", () => {
    const currentEdges = new Set<string>();

    for (const [globPath, source] of Object.entries(RAW_FILES)) {
      const path = normalizePath(globPath);
      if (!isProductionSource(path)) continue;
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const importedNames = match[1]
          .split(",")
          .map((name) => name.trim().replace(/^type\s+/, ""))
          .map((name) => name.split(/\s+as\s+/)[0]);
        for (const name of importedNames) {
          if (RESTRICTED_PRIMITIVES.has(name)) {
            currentEdges.add(`${path} -> ${name}`);
          }
        }
      }
    }

    const newEdges = [...currentEdges]
      .filter((edge) => !ALLOWED_EDGES.has(edge))
      .sort();
    const staleEdges = [...ALLOWED_EDGES]
      .filter((edge) => !currentEdges.has(edge))
      .sort();

    expect(
      newEdges,
      `Use TimelinePlacementMapper instead of adding low-level imports:\n${newEdges.join("\n")}`,
    ).toEqual([]);
    expect(
      staleEdges,
      `Remove migrated entries from the low-level allowlist:\n${staleEdges.join("\n")}`,
    ).toEqual([]);
  });
});
