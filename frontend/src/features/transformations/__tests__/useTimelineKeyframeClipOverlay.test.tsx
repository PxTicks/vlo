import type { ReactElement } from "react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND, useTimelineStore } from "../../timeline";
import { useTimelineKeyframeClipOverlay } from "../hooks/useTimelineKeyframeClipOverlay";
import { getDefaultSectionId, getDynamicSectionId } from "../publicApi";
import { useTransformationViewStore } from "../store/useTransformationViewStore";

const baseClip: TimelineClip = {
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
  transformations: [],
};

function useOverlayItems(clip: TimelineClip) {
  const overlay = useTimelineKeyframeClipOverlay();
  return overlay.useItems({ clip, isSelected: false });
}

describe("useTimelineKeyframeClipOverlay", () => {
  beforeEach(() => {
    useTransformationViewStore.setState({
      activeSection: null,
      activeSpline: null,
    });
    useTimelineStore.setState({
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
          type: "visual",
        },
      ],
      clips: [],
      selectedClipIds: [],
    });
  });

  it("returns layer-time overlay items for the active clip section with stable lanes and colors", () => {
    const clip: TimelineClip = {
      ...baseClip,
      transformations: [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: { x: 0, y: 0 },
          keyframeTimes: [120, 360],
        },
        {
          id: "scale_1",
          type: "scale",
          isEnabled: true,
          parameters: { x: 1, y: 1 },
          keyframeTimes: [240],
        },
        {
          id: "rotation_1",
          type: "rotation",
          isEnabled: true,
          parameters: { angle: 0 },
          keyframeTimes: [480],
        },
      ],
    };

    useTimelineStore.setState({ clips: [clip] });
    useTransformationViewStore.setState({
      activeSection: {
        clipId: clip.id,
        sectionId: getDefaultSectionId("layout"),
      },
    });

    const { result } = renderHook(() => useOverlayItems(clip));

    expect(result.current).toHaveLength(4);
    expect(result.current.map((item) => item.placement.kind)).toEqual([
      "layerTime",
      "layerTime",
      "layerTime",
      "layerTime",
    ]);
    expect(
      result.current.map((item) =>
        item.placement.kind === "layerTime" ? item.placement.transformId : null,
      ),
    ).toEqual(["position_1", "scale_1", "position_1", "rotation_1"]);
    expect(result.current.map((item) => item.placement.lane)).toEqual([
      "middle",
      "middle",
      "middle",
      "bottom",
    ]);

    const firstContent = result.current[0].content as ReactElement<{ sx?: { backgroundColor?: string } }>;
    const secondContent = result.current[1].content as ReactElement<{ sx?: { backgroundColor?: string } }>;
    expect(firstContent.props.sx?.backgroundColor).toBe("#648fff");
    expect(secondContent.props.sx?.backgroundColor).toBe("#dc267f");
  });

  it("projects active mask section keyframes onto the parent clip overlay", () => {
    const maskClipId = `${baseClip.id}::mask::mask-a`;
    const parentClip: TimelineClip = {
      ...baseClip,
      clipComponents: [
        {
          clipId: maskClipId,
          componentType: "mask",
        },
      ],
    };
    const maskClip: TimelineClip = {
      ...baseClip,
      id: maskClipId,
      type: "mask",
      parentClipId: parentClip.id,
      maskType: "rectangle",
      maskMode: "apply",
      maskInverted: false,
      maskParameters: { baseWidth: 100, baseHeight: 100 },
      transformations: [
        {
          id: "speed_1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 1 },
          keyframeTimes: [100, 200],
        },
      ],
    };

    useTimelineStore.setState({ clips: [parentClip, maskClip] });
    useTransformationViewStore.setState({
      activeSection: {
        clipId: maskClipId,
        sectionId: getDynamicSectionId("speed_1"),
      },
    });

    const { result } = renderHook(() => useOverlayItems(parentClip));

    expect(result.current).toHaveLength(2);
    expect(
      result.current.every(
        (item) =>
          item.placement.kind === "layerTime" &&
          item.placement.transformId === "speed_1",
      ),
    ).toBe(true);
    expect(result.current.every((item) => item.placement.lane === "middle")).toBe(true);
  });
});
