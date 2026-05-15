import type { ReactElement } from "react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { useProjectStore } from "../../../project/useProjectStore";
import { useTimelineMarkersClipOverlay } from "../useTimelineMarkersClipOverlay";
import { useTimelineStore } from "../../useTimelineStore";
import { useTimelineViewStore } from "../useTimelineViewStore";

const clipWithMarker: TimelineClip = {
  id: "clip_1",
  trackId: "track_1",
  start: 0,
  type: "video",
  assetId: "asset_1",
  name: "Clip 1",
  sourceDuration: 300,
  transformedDuration: 300,
  transformedOffset: 0,
  timelineDuration: 300,
  croppedSourceDuration: 300,
  offset: 0,
  transformations: [],
  components: [
    {
      id: "markers_1",
      type: "markers",
      parameters: {
        markers: [{ id: "marker_1", sourceTimeTicks: 120 }],
      },
    },
  ],
};

function useOverlayItems(clip: TimelineClip) {
  const overlay = useTimelineMarkersClipOverlay();
  return overlay.useItems({ clip, isSelected: false });
}

describe("useTimelineMarkersClipOverlay", () => {
  beforeEach(() => {
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
      clips: [clipWithMarker],
      selectedClipIds: [],
    });
    useTimelineViewStore.setState({ zoomScale: 1 });
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        fps: 30,
      },
    }));
  });

  it("uses the default cursor for draggable clip markers", () => {
    const { result } = renderHook(() => useOverlayItems(clipWithMarker));
    const content = result.current[0].content as ReactElement<{
      children: [
        ReactElement<{ sx?: { cursor?: string } }>,
        ReactElement | undefined,
      ];
    }>;

    expect(content.props.children[0].props.sx?.cursor).toBe("default");
  });
});
