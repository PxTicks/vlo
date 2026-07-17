import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../../types/Asset";
import type {
  CompositeAsset,
  TimelineClip,
} from "../../../../../types/TimelineTypes";
import {
  createCompositeBakeKey,
  serializeCompositeBakeKey,
} from "../../../../composite";
import type { TrackRenderEngine } from "../../TrackRenderEngine";
import {
  FrameJobResolver,
  compareResolvedJobToLegacy,
} from "../FrameJobResolver";
import { setCompositeRenderDagEnabled } from "../framePlanningFlags";
import type { ResolvedClipFrameJob } from "../framePlanningTypes";

const clip = { id: "clip-1" } as unknown as TimelineClip;

function job(overrides: Partial<ResolvedClipFrameJob> = {}): ResolvedClipFrameJob {
  return {
    id: "1:t1:clip-1",
    trackId: "t1",
    activeClip: clip,
    effectiveTrackTick: 120,
    rawClipTick: 0,
    sourceFrame: {
      key: "clip-1:120",
      generation: 1,
    } as ResolvedClipFrameJob["sourceFrame"],
    maskClips: [],
    logicalDimensions: { width: 1920, height: 1080 },
    contentSize: { width: 640, height: 360 },
    fps: 30,
    ...overrides,
  };
}

describe("compareResolvedJobToLegacy", () => {
  it("reports no mismatches when the planned job matches the legacy resolution", () => {
    const mismatches = compareResolvedJobToLegacy({
      job: job(),
      trackId: "t1",
      legacyActiveClip: clip,
      legacyEffectiveTick: 120,
      legacySourceFrameKey: "clip-1:120",
      legacyMaskClips: [],
      legacyVisible: true,
    });
    expect(mismatches).toEqual([]);
  });

  it("detects a divergent active clip, effective tick, and source frame", () => {
    const mismatches = compareResolvedJobToLegacy({
      job: job(),
      trackId: "t1",
      legacyActiveClip: { id: "clip-2" } as unknown as TimelineClip,
      legacyEffectiveTick: 121,
      legacySourceFrameKey: "clip-1:121",
      legacyMaskClips: [],
      legacyVisible: true,
    });
    expect(mismatches.map((m) => m.field).sort()).toEqual([
      "activeClip",
      "effectiveTick",
      "sourceFrame",
    ]);
  });

  it("flags a blank track that legacy considered visible", () => {
    const mismatches = compareResolvedJobToLegacy({
      job: null,
      trackId: "t1",
      legacyActiveClip: clip,
      legacyEffectiveTick: 120,
      legacyMaskClips: [],
      legacyVisible: true,
    });
    expect(mismatches.map((m) => m.field)).toContain("visibility");
    expect(mismatches.map((m) => m.field)).toContain("activeClip");
  });
});

describe("FrameJobResolver composite sources", () => {
  const asset = {
    id: "bake-1",
    hash: "bake-hash",
    name: "Bake",
    type: "video",
    src: "bake.mp4",
    createdAt: 1,
  } satisfies Asset;
  const placement = {
    id: "placement-1",
    trackId: "track-1",
    type: "video",
    name: "Composite",
    assetId: asset.id,
    compositeId: "composite-1",
    compositeRevision: 2,
    start: 100,
    sourceDuration: 1000,
    transformedDuration: 1000,
    transformedOffset: 0,
    timelineDuration: 1000,
    croppedSourceDuration: 1000,
    offset: 0,
    transformations: [],
  } satisfies TimelineClip;
  const content = {
    durationTicks: 1000,
    fps: 24,
    clips: [],
  };
  const expectedKey = serializeCompositeBakeKey(
    createCompositeBakeKey({
      content,
      projectFps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
      assets: [asset],
    }),
  );
  const composite = {
    id: "composite-1",
    name: "Composite",
    content,
    revision: 2,
    bake: {
      status: "ready",
      requestedKey: expectedKey,
      readyKey: expectedKey,
      readyRevision: 2,
      assetId: asset.id,
    },
    bakedAssetId: asset.id,
    createdAt: 1,
    updatedAt: 2,
  } satisfies CompositeAsset;

  afterEach(() => setCompositeRenderDagEnabled(false));

  function resolve(sourceComposite: CompositeAsset = composite) {
    const resolvedJob = job({
      activeClip: placement,
      sourceFrame: {
        ...job().sourceFrame,
        assetId: asset.id,
        sourceTimeTicks: 240,
        decodeKey: "bake-1:0:30:0",
      },
    });
    const engine = {
      resolveFrameJob: vi.fn(() => resolvedJob),
      presentBlankFrame: vi.fn(),
    } as unknown as TrackRenderEngine;
    return new FrameJobResolver().resolve({
      epoch: 1,
      presentationTick: 340,
      tracks: [
        {
          trackId: "track-1",
          engine,
          trackClips: [placement],
          maskClipsByParent: new Map(),
        },
      ],
      assets: [asset],
      composites: [sourceComposite],
      logicalDimensions: { width: 1920, height: 1080 },
      fps: 30,
    }).jobs[0];
  }

  it("resolves canonical content time and a validated bake fallback", () => {
    setCompositeRenderDagEnabled(true);

    const resolved = resolve();
    expect(resolved.compositeSource).toMatchObject({
      compositeId: composite.id,
      placementId: placement.id,
      revision: 2,
      bakeKey: expectedKey,
      localPresentationTick: 240,
      fps: 24,
      fallbackAssetId: asset.id,
    });
    expect(resolved.contentSize).toEqual({ width: 1920, height: 1080 });
  });

  it("does not expose a stale bake as fallback", () => {
    setCompositeRenderDagEnabled(true);

    expect(
      resolve({
        ...composite,
        bake: { ...composite.bake, readyKey: "stale-key" },
      }).compositeSource?.fallbackAssetId,
    ).toBeNull();
  });

  it("leaves baked source jobs unchanged while the rollout flag is off", () => {
    setCompositeRenderDagEnabled(false);
    expect(resolve().compositeSource).toBeUndefined();
  });
});
