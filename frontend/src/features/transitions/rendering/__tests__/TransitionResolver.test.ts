import { describe, expect, it } from "vitest";
import type {
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline/constants";
import { resolveTransitionFrame } from "../TransitionResolver";

function track(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function clip(
  id: string,
  trackId: string,
  start: number,
  duration: number,
): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: `asset-${id}`,
    start,
    timelineDuration: duration,
    sourceDuration: duration,
    croppedSourceDuration: duration,
    transformedDuration: duration,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
  };
}

function resolve(type: Transition["type"]) {
  const tracks = [track("upper"), track("lower")];
  const clips = [
    clip("outgoing", "lower", 0, 100),
    clip("incoming", "upper", 50, 100),
  ];
  return resolveTransitionFrame({
    tracks,
    clips,
    transitions: [
      {
        id: "transition-1",
        type,
        outgoingClipId: "outgoing",
        incomingClipId: "incoming",
        parameters: { easing: "linear", color: "#ff0000" },
      },
    ],
    fps: TICKS_PER_SECOND,
    presentationTick: 75,
    logicalDimensions: { width: 100, height: 50 },
    visualTrackOrder: ["upper", "lower"],
    adjustmentForest: [],
  });
}

describe("resolveTransitionFrame", () => {
  it("attaches per-side transforms", () => {
    const frame = resolve("dissolve");
    expect(frame.transformsByClipId.get("outgoing")?.[0].parameters.alpha).toBe(
      0.5,
    );
    expect(frame.transformsByClipId.get("incoming")?.[0].parameters.alpha).toBe(
      0.5,
    );
  });

  it("raises the outgoing track for slide-away", () => {
    const frame = resolve("slideAway");
    expect(frame.zIndexOverrides.get("lower")).toBe(1);
    expect(frame.zIndexOverrides.get("upper")).toBe(0);
  });

  it("emits a color layer for dip-to-color", () => {
    expect(resolve("dipToColor").colorLayers).toEqual([
      {
        id: "transition-1",
        color: "#ff0000",
        parentGroupId: null,
        zIndex: -0.5,
      },
    ]);
  });
});
