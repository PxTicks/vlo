import { describe, expect, it } from "vitest";

const BOUNDARY_FILES = import.meta.glob(
  [
    "../features/timeline/api.ts",
    "../features/timeline/useTimelineStore.ts",
    "../features/timelineSelection/utils/composite.ts",
  ],
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
) as Record<string, string>;

const LOW_LEVEL_PRESENTATION_PRIMITIVES = [
  "buildTimelineClipPresentationIndex",
  "resolveStoredStartForPresentationStart",
  "mapPresentationOffsetToClipOffset",
] as const;

describe("timeline placement mapper boundary", () => {
  it("keeps range-moving callers on the contextual placement mapper", () => {
    for (const [path, source] of Object.entries(BOUNDARY_FILES)) {
      expect(
        source,
        `${path} must construct a timeline placement mapper`,
      ).toContain("createTimelinePlacementMapper");
      for (const primitive of LOW_LEVEL_PRESENTATION_PRIMITIVES) {
        expect(
          source,
          `${path} must not compose ${primitive} directly`,
        ).not.toContain(primitive);
      }
      expect(
        source,
        `${path} must not subtract a range's presentation start from a stored clip start`,
      ).not.toMatch(/\.start\s*-\s*(?:selection|extractionRange|range)\.start/);
    }
  });
});
