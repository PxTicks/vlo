import { describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  CompositeContent,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline/constants";
import {
  COMPOSITE_FRAME_INTERVAL,
  COMPOSITE_RENDER_ALPHA_MODE,
  COMPOSITE_RENDER_CONTRACT_VERSION,
  COMPOSITE_RENDER_FRAME_STEP,
  collectCompositeDependencyAssetIds,
  createCompositeBakeKey,
  createCompositeDependencyRevision,
  createCompositeFrameSchedule,
  resolveCompositeFrameSample,
  serializeCompositeBakeKey,
} from "../compositeRenderContract";

function asset(id: string, hash: string): Asset {
  return {
    id,
    hash,
    name: id,
    type: id.startsWith("lut") ? "lut" : "video",
    src: `${id}.mp4`,
    createdAt: 1,
  };
}

function videoClip(): TimelineClip {
  return {
    id: "video",
    type: "video",
    name: "Video",
    assetId: "source-video",
    trackId: "visual",
    start: 0,
    sourceDuration: TICKS_PER_SECOND,
    timelineDuration: TICKS_PER_SECOND,
    croppedSourceDuration: TICKS_PER_SECOND,
    transformedDuration: TICKS_PER_SECOND,
    transformedOffset: 0,
    offset: 0,
    transformations: [
      {
        id: "grade",
        type: "colorGrade",
        isEnabled: true,
        parameters: { lutAssetId: "lut-one" },
      },
    ],
  };
}

function maskClip(): TimelineClip {
  return {
    id: "mask",
    type: "mask",
    name: "Mask",
    trackId: "mask-track",
    parentClipId: "video",
    start: 0,
    timelineDuration: TICKS_PER_SECOND,
    sourceDuration: TICKS_PER_SECOND,
    croppedSourceDuration: TICKS_PER_SECOND,
    transformedDuration: TICKS_PER_SECOND,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
    maskType: "sam2",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 1920, baseHeight: 1080 },
    sam2MaskAssetId: "sam-mask",
    generationMaskAssetId: "generation-mask",
    brushMaskAssetId: "brush-mask",
  };
}

function content(overrides: Partial<CompositeContent> = {}): CompositeContent {
  return {
    durationTicks: TICKS_PER_SECOND,
    fps: 30,
    tracks: [],
    clips: [videoClip(), maskClip()],
    ...overrides,
  };
}

describe("composite render contract", () => {
  it("builds a complete stable bake key", () => {
    const sourceContent = content();
    const assets = [
      asset("source-video", "video-hash"),
      asset("lut-one", "lut-hash"),
      asset("sam-mask", "sam-hash"),
      asset("generation-mask", "generation-hash"),
      asset("brush-mask", "brush-hash"),
    ];

    const key = createCompositeBakeKey({
      content: sourceContent,
      projectFps: 24,
      logicalDimensions: { width: 1919.4, height: 1079.6 },
      assets,
    });

    expect(key).toEqual({
      contentHash: expect.any(String),
      resolvedFps: 30,
      logicalWidth: 1919,
      logicalHeight: 1080,
      renderContractVersion: COMPOSITE_RENDER_CONTRACT_VERSION,
      alphaMode: COMPOSITE_RENDER_ALPHA_MODE,
      dependencyRevision: createCompositeDependencyRevision(
        sourceContent,
        assets,
      ),
    });
    expect(serializeCompositeBakeKey(key)).toBe(
      `v1:${key.contentHash}:30fps:1919x1080:transparent:${key.dependencyRevision}`,
    );
  });

  it("tracks core media, mask, and transform-owned dependencies", () => {
    expect(collectCompositeDependencyAssetIds(content())).toEqual([
      "brush-mask",
      "generation-mask",
      "lut-one",
      "sam-mask",
      "source-video",
    ]);
  });

  it("invalidates dependency identity when bytes arrive or change", () => {
    const sourceContent = content({ clips: [videoClip()] });
    const missing = createCompositeDependencyRevision(sourceContent, []);
    const first = createCompositeDependencyRevision(sourceContent, [
      asset("source-video", "hash-one"),
      asset("lut-one", "lut-hash"),
    ]);
    const second = createCompositeDependencyRevision(sourceContent, [
      asset("source-video", "hash-two"),
      asset("lut-one", "lut-hash"),
    ]);

    expect(first).not.toBe(missing);
    expect(second).not.toBe(first);
  });

  it("invalidates bake keys for dimensions and resolved project FPS", () => {
    const sourceContent = content({ fps: undefined, clips: [] });
    const base = createCompositeBakeKey({
      content: sourceContent,
      projectFps: 24,
      logicalDimensions: { width: 1920, height: 1080 },
      assets: [],
    });
    const fpsChanged = createCompositeBakeKey({
      content: sourceContent,
      projectFps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
      assets: [],
    });
    const dimensionsChanged = createCompositeBakeKey({
      content: sourceContent,
      projectFps: 24,
      logicalDimensions: { width: 1080, height: 1920 },
      assets: [],
    });

    expect(serializeCompositeBakeKey(fpsChanged)).not.toBe(
      serializeCompositeBakeKey(base),
    );
    expect(serializeCompositeBakeKey(dimensionsChanged)).not.toBe(
      serializeCompositeBakeKey(base),
    );
  });

  it("defines a half-open, every-frame playback schedule", () => {
    const schedule = createCompositeFrameSchedule(TICKS_PER_SECOND, 30);

    expect(schedule).toMatchObject({
      frameCount: 30,
      hasAuthoredFrames: true,
      interval: COMPOSITE_FRAME_INTERVAL,
      frameStep: COMPOSITE_RENDER_FRAME_STEP,
    });
    expect(resolveCompositeFrameSample(0, schedule)).toEqual({
      frameIndex: 0,
      presentationTick: 0,
    });
    expect(resolveCompositeFrameSample(TICKS_PER_SECOND - 1, schedule)).toEqual({
      frameIndex: 29,
      presentationTick: 29 * (TICKS_PER_SECOND / 30),
    });
    expect(resolveCompositeFrameSample(-1, schedule)).toBeNull();
    expect(resolveCompositeFrameSample(TICKS_PER_SECOND, schedule)).toBeNull();
  });

  it("encodes one transparent cache frame for an empty authored interval", () => {
    const schedule = createCompositeFrameSchedule(0, 30);
    expect(schedule).toMatchObject({
      frameCount: 1,
      hasAuthoredFrames: false,
    });
    expect(resolveCompositeFrameSample(0, schedule)).toBeNull();
  });
});
