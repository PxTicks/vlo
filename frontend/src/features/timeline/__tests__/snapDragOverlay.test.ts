import { describe, expect, it, vi } from "vitest";
import { buildFrameSnappedLayerTimeDrag } from "../utils/snapDragOverlay";
import { TICKS_PER_SECOND } from "../constants";
import type { TimelineClip, ClipTransform } from "../../../types/TimelineTypes";
import type { TimelineClipOverlayDragContext } from "../clipOverlayApi";

const FPS = 30;
const TPF = TICKS_PER_SECOND / FPS;

function makeClip(transformations: ClipTransform[]): TimelineClip {
  return {
    id: "clip_1",
    trackId: "track_1",
    start: 0,
    type: "video",
    assetId: "asset_1",
    name: "Clip 1",
    sourceDuration: 10 * TICKS_PER_SECOND,
    transformedDuration: 10 * TICKS_PER_SECOND,
    transformedOffset: 0,
    timelineDuration: 10 * TICKS_PER_SECOND,
    croppedSourceDuration: 10 * TICKS_PER_SECOND,
    offset: 0,
    transformations,
  };
}

function makeContext(deltaVisualTimeTicks: number): TimelineClipOverlayDragContext {
  return {
    clip: makeClip([]),
    isSelected: false,
    item: {
      id: "marker",
      content: null,
      visibility: "always",
      placement: {
        kind: "layerTime",
        transformId: "t",
        layerInputTicks: 0,
        lane: "middle",
        offsetPx: 0,
        verticalOffsetPx: 0,
      },
    },
    event: new Event("pointer") as unknown as PointerEvent,
    targetElement: document.createElement("div"),
    clipLocalX: 0,
    visualTimeTicks: 0,
    sourceTimeTicks: 0,
    deltaClipX: 0,
    deltaVisualTimeTicks,
    deltaSourceTimeTicks: 0,
  };
}

describe("buildFrameSnappedLayerTimeDrag", () => {
  it("snaps drop to the nearest whole frame when no neighbors constrain", () => {
    const onCommit = vi.fn();
    const handlers = buildFrameSnappedLayerTimeDrag({
      clip: makeClip([
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [TPF * 10],
        },
      ]),
      transformId: "position_1",
      initialLayerInputTicks: TPF * 10,
      prevNeighborLayerInputTicks: null,
      nextNeighborLayerInputTicks: null,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    // Drop 1.4 frames to the right -> should snap to +1 frame.
    handlers.onDragEnd?.(makeContext(TPF * 1.4));
    expect(onCommit).toHaveBeenCalledWith(TPF * 11);
  });

  it("clamps to the largest whole frame strictly less than the next neighbor", () => {
    const onCommit = vi.fn();
    const handlers = buildFrameSnappedLayerTimeDrag({
      clip: makeClip([
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [TPF * 5, TPF * 10, TPF * 13],
        },
      ]),
      transformId: "position_1",
      initialLayerInputTicks: TPF * 10,
      prevNeighborLayerInputTicks: TPF * 5,
      nextNeighborLayerInputTicks: TPF * 13,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    // Try to drop well past the next neighbor; should clamp to frame 12.
    handlers.onDragEnd?.(makeContext(TPF * 100));
    expect(onCommit).toHaveBeenCalledWith(TPF * 12);
  });

  it("clamps to the smallest whole frame strictly greater than the prev neighbor", () => {
    const onCommit = vi.fn();
    const handlers = buildFrameSnappedLayerTimeDrag({
      clip: makeClip([
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [TPF * 5, TPF * 10, TPF * 15],
        },
      ]),
      transformId: "position_1",
      initialLayerInputTicks: TPF * 10,
      prevNeighborLayerInputTicks: TPF * 5,
      nextNeighborLayerInputTicks: TPF * 15,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    handlers.onDragEnd?.(makeContext(-TPF * 100));
    expect(onCommit).toHaveBeenCalledWith(TPF * 6);
  });

  it("permits an interstitial neighbor (Z = F + epsilon) and lands on Frame F", () => {
    // Without speed transforms, layer-input == visual time, so an
    // interstitial neighbor sits at TPF*F + epsilon directly. The
    // largest snapped frame strictly < (TPF*F + epsilon) is TPF*F.
    const onCommit = vi.fn();
    const interstitialNext = TPF * 12 + 100; // small offset within one frame

    const handlers = buildFrameSnappedLayerTimeDrag({
      clip: makeClip([
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [TPF * 10, interstitialNext],
        },
      ]),
      transformId: "position_1",
      initialLayerInputTicks: TPF * 10,
      prevNeighborLayerInputTicks: null,
      nextNeighborLayerInputTicks: interstitialNext,
      // Tight enough that the 100-tick gap is OK (matches the user's
      // permissive spec — the input-domain safety guard would only
      // intervene under heavy speed compression).
      minNeighborSeparationTicks: 50,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    handlers.onDragEnd?.(makeContext(TPF * 5));
    expect(onCommit).toHaveBeenCalledWith(TPF * 12);
  });

  it("steps further from the neighbor when input-domain separation would collapse", () => {
    // Same setup as above, but raise the safety threshold so 100 ticks of
    // separation is no longer enough — the helper should back off one
    // frame to TPF*11.
    const onCommit = vi.fn();
    const interstitialNext = TPF * 12 + 100;

    const handlers = buildFrameSnappedLayerTimeDrag({
      clip: makeClip([
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [TPF * 10, interstitialNext],
        },
      ]),
      transformId: "position_1",
      initialLayerInputTicks: TPF * 10,
      prevNeighborLayerInputTicks: null,
      nextNeighborLayerInputTicks: interstitialNext,
      minNeighborSeparationTicks: 500, // > 100 ticks of slack at frame 12
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    handlers.onDragEnd?.(makeContext(TPF * 5));
    expect(onCommit).toHaveBeenCalledWith(TPF * 11);
  });

  it("falls back to the initial position when no whole frame fits between neighbors", () => {
    const onCommit = vi.fn();
    // Prev at frame 10, next at frame 11 — no whole frame is strictly
    // between them.
    const handlers = buildFrameSnappedLayerTimeDrag({
      clip: makeClip([
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [TPF * 10, TPF * 10 + 50, TPF * 11],
        },
      ]),
      transformId: "position_1",
      initialLayerInputTicks: TPF * 10 + 50,
      prevNeighborLayerInputTicks: TPF * 10,
      nextNeighborLayerInputTicks: TPF * 11,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    handlers.onDragEnd?.(makeContext(TPF * 0.3));
    expect(onCommit).toHaveBeenCalledWith(TPF * 10 + 50);
  });
});
