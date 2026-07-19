import type { MouseEvent, ReactElement } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { contextMenuService } from "../../../../core/shell/contextMenuService";
import { useProjectStore } from "../../../project/useProjectStore";
import { useTimelineMarkersClipOverlay, MARKER_COLOR, BEAT_MARKER_COLOR } from "../useTimelineMarkersClipOverlay";
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

const clipWithBeatMarker: TimelineClip = {
  id: "clip_2",
  trackId: "track_1",
  start: 0,
  type: "video",
  assetId: "asset_1",
  name: "Clip 2",
  sourceDuration: 300,
  transformedDuration: 300,
  transformedOffset: 0,
  timelineDuration: 300,
  croppedSourceDuration: 300,
  offset: 0,
  transformations: [],
  components: [
    {
      id: "markers_2",
      type: "markers",
      parameters: {
        markers: [{ id: "marker_2", sourceTimeTicks: 120, kind: "beat" }],
      },
    },
  ],
};

function useOverlayItems(clip: TimelineClip) {
  const overlay = useTimelineMarkersClipOverlay();
  return overlay.useItems({ clip, isSelected: false });
}

type IconProps = {
  sx?: { cursor?: string; color?: string; outline?: string };
};

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
      clips: [clipWithMarker, clipWithBeatMarker],
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

  afterEach(() => {
    act(() => contextMenuService.close());
  });

  it("uses the default cursor for draggable clip markers", () => {
    const { result } = renderHook(() => useOverlayItems(clipWithMarker));
    const content = result.current[0].content as ReactElement<IconProps>;
    expect(content.props.sx?.cursor).toBe("default");
  });

  it("colors standard markers with MARKER_COLOR", () => {
    const { result } = renderHook(() => useOverlayItems(clipWithMarker));
    const content = result.current[0].content as ReactElement<IconProps>;
    expect(content.props.sx?.color).toBe(MARKER_COLOR);
  });

  it("colors beat markers with BEAT_MARKER_COLOR", () => {
    const { result } = renderHook(() => useOverlayItems(clipWithBeatMarker));
    const content = result.current[0].content as ReactElement<IconProps>;
    expect(content.props.sx?.color).toBe(BEAT_MARKER_COLOR);
  });

  it("shows the catalogued marker menu on right-click and outlines its marker", () => {
    const { result } = renderHook(() => useOverlayItems(clipWithMarker));

    act(() => {
      result.current[0].onContextMenu?.({
        clientX: 12,
        clientY: 34,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      } as unknown as MouseEvent<HTMLDivElement>);
    });

    const active = contextMenuService.getActive();
    expect(active).toMatchObject({
      menuId: "timeline.marker.context",
      position: { x: 12, y: 34 },
      subject: {
        slot: "timeline.marker.context",
        marker: { id: "marker_1", sourceTimeTicks: 120, kind: "marker" },
        clip: { id: "clip_1", trackId: "track_1" },
      },
    });
    expect(active?.items).toMatchObject([
      {
        kind: "command",
        command: "timeline.marker.delete",
        subject: { clipId: "clip_1", markerId: "marker_1" },
      },
    ]);

    // The menu-target marker gets the open-menu outline; other clips' items
    // do not.
    const content = result.current[0].content as ReactElement<IconProps>;
    expect(content.props.sx?.outline).toContain(MARKER_COLOR);
    const other = renderHook(() => useOverlayItems(clipWithBeatMarker));
    const otherContent = other.result.current[0].content as ReactElement<IconProps>;
    expect(otherContent.props.sx?.outline).toBeUndefined();
  });
});
