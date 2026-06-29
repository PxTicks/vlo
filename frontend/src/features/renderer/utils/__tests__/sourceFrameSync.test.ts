import { describe, it, expect } from "vitest";
import {
  createDecodeKey,
  createSourceFrameSyncKey,
  createSourceFrameSyncRef,
  createSourceFrameSyncRefFromSourceTicks,
  isSourceFrameIntentCurrent,
  type SourceFrameSyncRef,
} from "../sourceFrameSync";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { SpeedTransform } from "../../../transformations/types";
import { resolveClipRenderTimeFromEffectiveTick } from "../clipRenderTime";

/**
 * Feature-facing frame-sync regression suite (ratchet step 5).
 *
 * The point is NOT to re-test the timing math — `mediaTime.test.ts` /
 * `renderTime.test.ts` own that. This suite proves the feature-facing
 * `SourceFrameSyncRef` cannot silently fall back to a private timing model:
 * the SAME source-frame intent must yield the SAME `key`/`frameIndex` no matter
 * how the playhead arrived there (forward vs backward scrub, clip placement,
 * trim/offset, speed), and stale async completions must be rejected by intent
 * rather than by a "newer frame wins" rule.
 */

const FPS = 30;
// 96000 / 30 -> a source frame is exactly 3200 ticks at 30fps, so every value
// below stays on integer ticks and the math is easy to reason about.
const TICKS_PER_FRAME = TICKS_PER_SECOND / FPS;
const ASSET_ID = "asset-1";

function buildClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  const duration = 10 * TICKS_PER_SECOND;
  return {
    id: "clip-1",
    name: "Clip 1",
    assetId: ASSET_ID,
    type: "video",
    trackId: "track-1",
    start: 0,
    timelineDuration: duration,
    sourceDuration: duration,
    transformedDuration: duration,
    transformedOffset: 0,
    croppedSourceDuration: duration,
    offset: 0,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

function speedTransform(factor: number): SpeedTransform {
  return {
    id: "speed-1",
    type: "speed",
    isEnabled: true,
    parameters: { factor },
  } as SpeedTransform;
}

function refAt(
  clip: TimelineClip,
  effectiveTrackTick: number,
  generation = 0,
): SourceFrameSyncRef {
  return createSourceFrameSyncRef({
    clip,
    assetId: ASSET_ID,
    effectiveTrackTick,
    fps: FPS,
    generation,
  });
}

describe("SourceFrameSyncRef regression", () => {
  it("is direction-agnostic: scrubbing forward and backward yields identical refs per tick", () => {
    const clip = buildClip();
    const ticks = [0, TICKS_PER_FRAME, 2 * TICKS_PER_FRAME, 3 * TICKS_PER_FRAME];

    const forward = ticks.map((t) => refAt(clip, t));
    const backward = [...ticks].reverse().map((t) => refAt(clip, t));

    // Re-pair backward results with their tick so we compare like-for-like.
    const backwardByTick = new Map(
      [...ticks].reverse().map((t, i) => [t, backward[i]]),
    );

    for (let i = 0; i < ticks.length; i += 1) {
      expect(backwardByTick.get(ticks[i])).toEqual(forward[i]);
    }

    // Distinct source frames must produce distinct keys — no collapsing.
    const keys = new Set(forward.map((r) => r.key));
    expect(keys.size).toBe(ticks.length);
  });

  it("collapses ticks within one source frame to a single key (nearest-frame snapping)", () => {
    const clip = buildClip();
    // Nearest-frame snapping: frame 0 owns [0, 1/2 frame); frame 1 owns the
    // next half-open interval. Two ticks inside the same bucket are one intent.
    const insideFrameZeroA = refAt(clip, 0);
    const insideFrameZeroB = refAt(clip, TICKS_PER_FRAME / 2 - 1);
    const insideFrameOne = refAt(clip, TICKS_PER_FRAME);

    expect(insideFrameZeroA.frameIndex).toBe(0);
    expect(insideFrameZeroB.frameIndex).toBe(0);
    expect(insideFrameZeroA.key).toBe(insideFrameZeroB.key);

    expect(insideFrameOne.frameIndex).toBe(1);
    expect(insideFrameOne.key).not.toBe(insideFrameZeroA.key);
  });

  it("derives frame identity from the clip-relative tick, not absolute placement", () => {
    const atZero = buildClip({ id: "c", start: 0 });
    const shifted = buildClip({ id: "c", start: 5 * TICKS_PER_SECOND });

    const rawTick = 2 * TICKS_PER_FRAME;
    const fromZero = refAt(atZero, rawTick);
    const fromShifted = refAt(shifted, shifted.start + rawTick);

    // Same clip id + same relative position -> identical source-frame intent,
    // regardless of where the clip sits on the timeline.
    expect(fromShifted.frameIndex).toBe(fromZero.frameIndex);
    expect(fromShifted.key).toBe(fromZero.key);
    expect(fromShifted.frameIndex).toBe(2);
  });

  it("accounts for a trimmed transformedOffset in the source frame", () => {
    const trimmed = buildClip({ transformedOffset: 3 * TICKS_PER_FRAME });

    // At the clip's visual start the source is already 3 frames in.
    const atStart = refAt(trimmed, trimmed.start);
    expect(atStart.frameIndex).toBe(3);

    const untrimmed = buildClip({ transformedOffset: 0 });
    expect(refAt(untrimmed, untrimmed.start).frameIndex).toBe(0);
  });

  it("changes frame identity when source fps changes", () => {
    const clip = buildClip();
    const effectiveTrackTick = 3 * TICKS_PER_FRAME; // 0.1s of source

    const at30 = createSourceFrameSyncRef({
      clip,
      assetId: ASSET_ID,
      effectiveTrackTick,
      fps: 30,
      generation: 0,
    });
    const at60 = createSourceFrameSyncRef({
      clip,
      assetId: ASSET_ID,
      effectiveTrackTick,
      fps: 60,
      generation: 0,
    });

    expect(at30.frameIndex).toBe(3);
    expect(at60.frameIndex).toBe(6);
    expect(at30.key).not.toBe(at60.key);
  });

  it("flows speed transforms through into the source frame", () => {
    const fast = buildClip({ transformations: [speedTransform(2)] });
    const rawTick = TICKS_PER_FRAME; // consumes 2 frames of source at 2x

    const ref = refAt(fast, fast.start + rawTick);

    // The ref must match composing the documented helpers directly, proving it
    // does not reconstruct timing privately.
    const renderTime = resolveClipRenderTimeFromEffectiveTick({
      clip: fast,
      effectiveTrackTick: fast.start + rawTick,
    });
    const expected = createSourceFrameSyncRefFromSourceTicks({
      clip: fast,
      assetId: ASSET_ID,
      effectiveTrackTick: fast.start + rawTick,
      rawClipTick: rawTick,
      sourceTimeTicks: renderTime.sourceTimeTicks,
      fps: FPS,
      generation: 0,
    });

    expect(ref).toEqual(expected);
    expect(ref.sourceTimeTicks).toBe(2 * TICKS_PER_FRAME);
    // 2x speed: one timeline frame of travel lands on source frame 2.
    expect(ref.frameIndex).toBe(2);
  });

  it("rejects stale async completions by generation even when the frame matches", () => {
    const clip = buildClip();
    const tick = 2 * TICKS_PER_FRAME;

    // An async request captured during generation 1.
    const requested = refAt(clip, tick, 1);

    // The playhead later returns to the very same source frame, but the render
    // generation has advanced (e.g. a re-render after scrub/loop).
    const currentSameFrame = refAt(clip, tick, 2);
    expect(currentSameFrame.key).toBe(requested.key);

    // "Newer frame wins" would accept this; "same intent wins" must not.
    expect(
      isSourceFrameIntentCurrent(currentSameFrame, requested),
    ).toBe(false);
  });

  it("rejects stale completions for a different frame within the same generation", () => {
    const clip = buildClip();
    const requested = refAt(clip, 2 * TICKS_PER_FRAME, 5);
    const currentDifferentFrame = refAt(clip, 7 * TICKS_PER_FRAME, 5);

    expect(
      isSourceFrameIntentCurrent(currentDifferentFrame, requested),
    ).toBe(false);
  });

  it("accepts a completion only when both generation and key match", () => {
    const clip = buildClip();
    const requested = refAt(clip, 4 * TICKS_PER_FRAME, 9);
    const current = refAt(clip, 4 * TICKS_PER_FRAME, 9);

    expect(isSourceFrameIntentCurrent(current, requested)).toBe(true);
    expect(isSourceFrameIntentCurrent(null, requested)).toBe(false);
  });
});

describe("decodeKey", () => {
  it("collapses duplicate clips at the same source frame to one decode key while keeping clip keys distinct", () => {
    const clipA = buildClip({ id: "clip-a" });
    const clipB = buildClip({ id: "clip-b" });
    const tick = 2 * TICKS_PER_FRAME;

    const refA = refAt(clipA, tick);
    const refB = refAt(clipB, tick);

    // Same asset/frame/fps/time -> one shared decode...
    expect(refA.decodeKey).not.toBeNull();
    expect(refA.decodeKey).toBe(refB.decodeKey);
    // ...but the clip-scoped keys still differ, so stale-completion routing
    // stays per clip.
    expect(refA.key).not.toBe(refB.key);
    // The decode key is strictly the clip key without the clip id.
    expect(refA.key).toBe(`${clipA.id}:${refA.decodeKey}`);
  });

  it("changes the decode key when asset, fps, frame index, or snapped time differ", () => {
    const base = {
      assetId: ASSET_ID,
      frameIndex: 2,
      fps: FPS,
      snappedTimeSeconds: 2 / FPS,
    };
    const baseKey = createDecodeKey(base);

    expect(createDecodeKey({ ...base, assetId: "asset-2" })).not.toBe(baseKey);
    expect(createDecodeKey({ ...base, fps: 60 })).not.toBe(baseKey);
    expect(createDecodeKey({ ...base, frameIndex: 3 })).not.toBe(baseKey);
    expect(
      createDecodeKey({ ...base, snappedTimeSeconds: 3 / FPS }),
    ).not.toBe(baseKey);
  });

  it("is null for non-asset (text/brush) frames so they never dedupe", () => {
    // Text/brush clips resolve a null assetId into the ref factory; the clip
    // shape itself is irrelevant — the null asset is what suppresses dedup.
    const clip = buildClip({ id: "text-1" });
    const ref = createSourceFrameSyncRef({
      clip,
      assetId: null,
      effectiveTrackTick: clip.start + 2 * TICKS_PER_FRAME,
      fps: FPS,
      generation: 0,
    });

    expect(ref.decodeKey).toBeNull();
    expect(createDecodeKey({ assetId: null, frameIndex: 0, fps: FPS, snappedTimeSeconds: 0 })).toBeNull();
    expect(createDecodeKey({ assetId: "", frameIndex: 0, fps: FPS, snappedTimeSeconds: 0 })).toBeNull();
  });

  it("stays in lockstep with the clip key's frame snapping", () => {
    const clip = buildClip();
    // Two ticks inside the same source frame snap to one decode key, mirroring
    // the clip-key snapping behaviour above.
    const insideFrameZeroA = refAt(clip, 0);
    const insideFrameZeroB = refAt(clip, TICKS_PER_FRAME / 2 - 1);
    const insideFrameOne = refAt(clip, TICKS_PER_FRAME);

    expect(insideFrameZeroA.decodeKey).toBe(insideFrameZeroB.decodeKey);
    expect(insideFrameOne.decodeKey).not.toBe(insideFrameZeroA.decodeKey);

    // And the helper composes identically to the ref's embedded key.
    expect(
      createSourceFrameSyncKey({
        clipId: clip.id,
        assetId: ASSET_ID,
        frameIndex: insideFrameOne.frameIndex,
        fps: FPS,
        snappedTimeSeconds: insideFrameOne.snappedTimeSeconds,
      }),
    ).toBe(insideFrameOne.key);
  });
});
