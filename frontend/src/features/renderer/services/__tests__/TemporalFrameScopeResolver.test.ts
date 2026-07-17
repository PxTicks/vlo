import { describe, expect, it, vi } from "vitest";
import type {
  ClipTransform,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import type { AdjustmentEffectResolver } from "../AdjustmentEffectResolver";

vi.mock("../../../transformations/catalogue/TransformationRegistry", () => ({
  getEntryForTransform: (transform: ClipTransform) => ({
    rendering:
      transform.type === "filter" &&
      "filterName" in transform &&
      transform.filterName === "test/composite-history"
        ? {
            timeDependency: "history",
            maxHistorySeconds: 2,
            maxStepSeconds: 1 / 30,
          }
        : undefined,
  }),
}));

import { collectTemporalFrameScope } from "../TemporalFrameScopeResolver";

function historyTransform(id: string): ClipTransform {
  return {
    id,
    type: "filter",
    filterName: "test/composite-history",
    isEnabled: true,
    parameters: {},
  } as ClipTransform;
}

describe("collectTemporalFrameScope", () => {
  it("uses the supplied local clock for child clips and adjustment groups", () => {
    const childClip = {
      id: "child",
      trackId: "child-track",
      type: "video",
      assetId: "child-asset",
      transformations: [historyTransform("child-history")],
    } as unknown as TimelineClip;
    const adjustmentClip = {
      id: "adjustment",
      trackId: "adjustment-track",
      type: "adjustment",
      transformations: [historyTransform("adjustment-history")],
    } as unknown as TimelineClip;
    const resolveActiveClipAtPresentation = vi.fn(() => ({
      activeClip: childClip,
      effectiveTick: 740,
      presentationStart: 400,
    }));
    const deriveGroups = vi.fn(() => [
      {
        id: "adjustment@child-track",
        sourceClipId: "adjustment",
        transformations: adjustmentClip.transformations,
        start: 100,
        timelineDuration: 1000,
        sampleTick: 700,
        trackIds: ["child-track"],
        children: [],
      },
    ]);

    const scope = collectTemporalFrameScope({
      presentationTick: 700,
      tracks: [
        {
          trackId: "child-track",
          trackClips: [childClip],
          activeClipResolver: { resolveActiveClipAtPresentation },
        },
      ],
      stableClips: [adjustmentClip, childClip],
      adjustmentEffectResolver: {
        deriveGroups,
      } as unknown as AdjustmentEffectResolver,
    });

    expect(resolveActiveClipAtPresentation).toHaveBeenCalledWith(
      [childClip],
      700,
    );
    expect(deriveGroups).toHaveBeenCalledWith(700);
    expect(scope.requirements).toEqual({
      timeDependency: "history",
      maxHistorySeconds: 2,
      maxStepSeconds: 1 / 30,
    });
    expect(scope.earliestTick).toBe(100);
    expect(scope.topologyKey).toContain("child-history");
    expect(scope.topologyKey).toContain("adjustment-history");
    expect(scope.topologyKey).toContain("child:video:asset:child-asset");
  });

  it("changes topology when the active child source changes", () => {
    const createScope = (assetId: string) => {
      const clip = {
        id: "child",
        trackId: "track",
        type: "video",
        assetId,
        transformations: [],
      } as unknown as TimelineClip;
      return collectTemporalFrameScope({
        presentationTick: 0,
        tracks: [
          {
            trackId: "track",
            trackClips: [clip],
            activeClipResolver: {
              resolveActiveClipAtPresentation: () => ({
                activeClip: clip,
                effectiveTick: 0,
                presentationStart: 0,
              }),
            },
          },
        ],
        stableClips: [clip],
        adjustmentEffectResolver: {
          deriveGroups: () => [],
        } as unknown as AdjustmentEffectResolver,
      });
    };

    expect(createScope("asset-a").topologyKey).not.toBe(
      createScope("asset-b").topologyKey,
    );
  });
});
