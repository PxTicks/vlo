import { describe, expect, it, vi } from "vitest";
import { buildFrameSnappedSourceTimeDrag } from "../utils/snapDragOverlay";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../constants";
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
        kind: "sourceTime",
        sourceTimeTicks: 0,
        lane: "middle",
        offsetPx: 0,
        verticalOffsetPx: 0,
      },
    },
    event: new Event("pointer") as unknown as PointerEvent,
    targetElement: document.createElement("div"),
    clipLocalX: 0,
    presentationOffsetTicks: 0,
    visualTimeTicks: 0,
    sourceTimeTicks: 0,
    deltaClipX: 0,
    deltaPresentationOffsetTicks: deltaVisualTimeTicks,
    deltaVisualTimeTicks,
    deltaSourceTimeTicks: 0,
    mapPresentationOffsetToClipOffset: (offset) => offset,
    mapClipOffsetToPresentationOffset: (offset) => offset,
  };
}

describe("buildFrameSnappedSourceTimeDrag", () => {
  it("commits snapped source time under clip speed", () => {
    const onCommit = vi.fn();
    const handlers = buildFrameSnappedSourceTimeDrag({
      clip: makeClip([
        {
          id: "speed_1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ]),
      initialSourceTimeTicks: TPF * 10,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    // Source 10f renders at visual 5f under 2x speed. Dropping 1.4
    // visual frames later snaps to visual 6f, which is source 12f.
    handlers.onDragEnd?.(makeContext(TPF * 1.4));
    expect(onCommit).toHaveBeenCalledWith(TPF * 12);
  });

  it("steps further from a neighbor when source-time separation would collapse", () => {
    const onCommit = vi.fn();
    const interstitialNext = TPF * 12 + 100;
    const handlers = buildFrameSnappedSourceTimeDrag({
      clip: makeClip([]),
      initialSourceTimeTicks: TPF * 10,
      prevNeighborSourceTimeTicks: null,
      nextNeighborSourceTimeTicks: interstitialNext,
      minNeighborSeparationTicks: 500,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit,
    });

    handlers.onDragEnd?.(makeContext(TPF * 5));
    expect(onCommit).toHaveBeenCalledWith(TPF * 11);
  });

  it("uses presentation-space distance for the live drag offset", () => {
    const handlers = buildFrameSnappedSourceTimeDrag({
      clip: makeClip([]),
      initialSourceTimeTicks: TPF * 10,
      getTicksPerFrame: () => TPF,
      getZoomScale: () => 1,
      onCommit: vi.fn(),
    });
    const context = {
      ...makeContext(TPF * 2.2),
      mapClipOffsetToPresentationOffset: (offset: number) => offset / 2,
    };

    handlers.onDrag?.(context);

    const dx = Number.parseFloat(
      context.targetElement.style.getPropertyValue("--overlay-drag-dx"),
    );
    const expectedDx = (TPF / TICKS_PER_SECOND) * PIXELS_PER_SECOND;
    expect(dx).toBeCloseTo(expectedDx);
  });
});
