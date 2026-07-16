import { describe, expect, it, vi } from "vitest";
import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import type { FilterRenderContext } from "../types";

vi.mock("../TransformationRegistry", () => ({
  getEntryForTransform: (transform: ClipTransform) => {
    const dependency =
      transform.type === "filter" && "filterName" in transform
        ? transform.filterName
        : null;
    if (dependency === "test/sample") {
      return {
        rendering: {
          timeDependency: "sample",
          maxHistorySeconds: 0,
          maxStepSeconds: 0.1,
        },
      };
    }
    if (dependency === "test/history-short") {
      return {
        rendering: {
          timeDependency: "history",
          maxHistorySeconds: 2,
          maxStepSeconds: 1 / 30,
        },
      };
    }
    if (dependency === "test/history-long") {
      return {
        rendering: {
          timeDependency: "history",
          maxHistorySeconds: 5,
          maxStepSeconds: 1 / 60,
        },
      };
    }
    return { rendering: undefined };
  },
}));

import {
  collectClipTemporalRenderingRequirements,
  collectTemporalRenderingRequirements,
  getTemporalSampleCacheIdentity,
  getTemporalClipSourceIdentity,
  getTemporalTransformationTopologyKey,
} from "../temporalRenderingRequirements";

function filter(
  id: string,
  filterName: string,
  isEnabled = true,
): ClipTransform {
  return {
    id,
    type: "filter",
    filterName,
    isEnabled,
    parameters: {},
  } as ClipTransform;
}

const RENDER: FilterRenderContext = {
  sequenceId: 7,
  sampleId: 42,
  mode: "preview",
  continuity: "sequential",
  presentationTimeTicks: 100,
  visualTimeTicks: 100,
  sourceTimeTicks: 100,
  deltaTimeTicks: 1,
  fps: 30,
  isWarmup: false,
};

describe("temporal rendering requirements", () => {
  it("merges active policies using maximum history and minimum step", () => {
    const result = collectTemporalRenderingRequirements([
      [
        filter("sample", "test/sample"),
        filter("short", "test/history-short"),
      ],
      [
        filter("long", "test/history-long"),
        filter("disabled", "test/history-long", false),
      ],
    ]);

    expect(result).toEqual({
      timeDependency: "history",
      maxHistorySeconds: 5,
      maxStepSeconds: 1 / 60,
    });
  });

  it("collects policies from clip transformation stacks", () => {
    const clips = [
      { transformations: [filter("history", "test/history-short")] },
      { transformations: [filter("sample", "test/sample")] },
    ] as TimelineClip[];

    expect(collectClipTemporalRenderingRequirements(clips)).toEqual({
      timeDependency: "history",
      maxHistorySeconds: 2,
      maxStepSeconds: 1 / 30,
    });
  });

  it("adds logical sample identity only for time-dependent cache entries", () => {
    expect(
      getTemporalSampleCacheIdentity(
        [filter("history", "test/history-short")],
        RENDER,
      ),
    ).toBe("sample:7:42");
    expect(
      getTemporalSampleCacheIdentity(
        [filter("stateless", "test/stateless")],
        RENDER,
      ),
    ).toBeNull();
  });

  it("keys temporal topology by enabled transform identity and order", () => {
    const first = filter("history-a", "test/history-short");
    const second = filter("history-b", "test/history-long");

    const key = getTemporalTransformationTopologyKey([[first, second]]);
    expect(key).toContain("history-a");
    expect(key).toContain("history-b");
    expect(getTemporalTransformationTopologyKey([[second, first]])).not.toBe(
      key,
    );
    expect(
      getTemporalTransformationTopologyKey([
        [first, filter("disabled", "test/history-long", false)],
      ]),
    ).toBe(getTemporalTransformationTopologyKey([[first]]));
  });

  it("changes clip source identity when an asset is replaced in place", () => {
    const clip = {
      id: "clip-1",
      type: "video",
      assetId: "asset-a",
    } as TimelineClip;

    expect(
      getTemporalClipSourceIdentity({ ...clip, assetId: "asset-b" }),
    ).not.toBe(getTemporalClipSourceIdentity(clip));
  });
});
