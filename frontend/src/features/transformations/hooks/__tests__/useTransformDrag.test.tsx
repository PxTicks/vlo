import { fireEvent, render, screen, act } from "@testing-library/react";
import { useEffect, useRef, type RefObject } from "react";
import type {
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../project";
import { useAssetStore } from "../../../userAssets";
import { useInteractionStore } from "../../../timeline/hooks/useInteractionStore";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import {
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
} from "../../../timeline/constants";
import type { Asset } from "../../../../types/Asset";
import {
  ADJUSTMENT_DEPTH_ALL,
  ADJUSTMENT_RETIMING_STATIC,
} from "../../../../types/TimelineTypes";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { useTransformDrag } from "../useTransformDrag";

const latestTransformDragHandlersRef: {
  current:
    | (ReturnType<typeof useTransformDrag> & {
        scrollContainerRef: RefObject<HTMLDivElement | null>;
      })
    | null;
} = { current: null };

const BLUR_DRAG_DATA = {
  type: "transform",
  transformType: "BlurFilter",
  isFilter: true,
  label: "Blur",
} as const;

function makeTrack(
  id: string,
  type: NonNullable<TimelineTrack["type"]>,
): TimelineTrack {
  return {
    id,
    type,
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function videoClip(id: string, trackId: string): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: "asset-video",
    start: 0,
    timelineDuration: 192000,
    sourceDuration: 192000,
    transformedDuration: 192000,
    transformedOffset: 0,
    croppedSourceDuration: 192000,
    offset: 0,
    transformations: [],
  };
}

function audioClip(id: string, trackId: string): TimelineClip {
  return {
    id,
    type: "audio",
    name: id,
    trackId,
    assetId: "asset-audio",
    start: 0,
    timelineDuration: 192000,
    sourceDuration: 192000,
    transformedDuration: 192000,
    transformedOffset: 0,
    croppedSourceDuration: 192000,
    offset: 0,
    transformations: [],
  };
}

function adjustmentClip(
  id: string,
  trackId: string,
  start: number,
  timelineDuration: number,
): TimelineClip {
  return {
    id,
    type: "adjustment",
    name: id,
    trackId,
    start,
    timelineDuration,
    sourceDuration: timelineDuration,
    transformedDuration: timelineDuration,
    transformedOffset: 0,
    croppedSourceDuration: timelineDuration,
    offset: 0,
    transformations: [],
    depth: ADJUSTMENT_DEPTH_ALL,
    retimingMode: ADJUSTMENT_RETIMING_STATIC,
  };
}

function makeAsset(overrides: Pick<Asset, "id" | "name" | "type">): Asset {
  return {
    ...overrides,
    src: `${overrides.id}.mp4`,
    duration: 2,
    createdAt: 1,
    hash: `hash-${overrides.id}`,
    hasAudio: overrides.type === "video" ? true : undefined,
  };
}

function mockRect(element: HTMLElement, rect: Partial<DOMRect>) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    top: rect.top ?? 0,
    left: rect.left ?? 0,
    right: (rect.left ?? 0) + (rect.width ?? 0),
    bottom: (rect.top ?? 0) + (rect.height ?? 0),
    toJSON: () => {},
  } as DOMRect);
}

function makeTransformDragStartEvent(): DragStartEvent {
  return {
    active: {
      id: "transform_BlurFilter",
      data: { current: BLUR_DRAG_DATA },
    },
  } as unknown as DragStartEvent;
}

function makeTransformDragEndEvent(): DragEndEvent {
  return {
    active: {
      id: "transform_BlurFilter",
      data: { current: BLUR_DRAG_DATA },
    },
    over: null,
    delta: { x: 0, y: 0 },
    activatorEvent: null,
  } as unknown as DragEndEvent;
}

function TestTransformDragApp() {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const handlers = useTransformDrag(scrollContainerRef);

  useEffect(() => {
    latestTransformDragHandlersRef.current = {
      ...handlers,
      scrollContainerRef,
    };
  });

  return (
    <div
      ref={scrollContainerRef}
      data-testid="timeline-container"
      style={{ position: "relative", height: 600, overflow: "auto" }}
    />
  );
}

describe("useTransformDrag", () => {
  beforeEach(() => {
    latestTransformDragHandlersRef.current = null;
    useInteractionStore.setState({
      activeClip: null,
      activeId: null,
      operation: null,
      transformDropPreview: null,
      isOverTimeline: false,
    });
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        aspectRatio: "16:9",
        fps: 30,
        fitMode: "cover",
        layoutMode: "compact",
        assetBrowserDisplay: "grouped",
      },
    }));
    useAssetStore.setState({
      assets: [
        makeAsset({ id: "asset-video", name: "Video", type: "video" }),
        makeAsset({ id: "asset-audio", name: "Audio", type: "audio" }),
      ],
      families: [],
    });
  });

  it("rejects drops over the sticky header column even after horizontal scroll", () => {
    useTimelineStore.setState({
      tracks: [makeTrack("track-video", "visual")],
      clips: [videoClip("clip-video", "track-video")],
      selectedClipIds: [],
    });

    render(<TestTransformDragApp />);

    const container = screen.getByTestId("timeline-container");
    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });
    // The header is sticky: content-space math would let this fall through.
    Object.defineProperty(container, "scrollLeft", {
      value: 500,
      configurable: true,
    });

    act(() => {
      // Cursor sits over the sticky track-header column (x < TRACK_HEADER_WIDTH).
      fireEvent.pointerMove(window, {
        clientX: 40,
        clientY: RULER_HEIGHT + 30,
        buttons: 1,
      });
      latestTransformDragHandlersRef.current?.handleTransformDragStart(
        makeTransformDragStartEvent(),
      );
      latestTransformDragHandlersRef.current?.handleTransformDragEnd(
        makeTransformDragEndEvent(),
      );
    });

    const state = useTimelineStore.getState();
    expect(state.clips[0].transformations).toEqual([]);
    expect(state.clips.some((c) => c.type === "adjustment")).toBe(false);
    expect(state.selectedClipIds).toEqual([]);
  });

  it("drops a compatible transformation onto a clip and appends it to the stack", () => {
    useTimelineStore.setState({
      tracks: [makeTrack("track-video", "visual")],
      clips: [videoClip("clip-video", "track-video")],
      selectedClipIds: [],
    });

    render(<TestTransformDragApp />);

    const container = screen.getByTestId("timeline-container");
    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });

    act(() => {
      fireEvent.pointerMove(window, {
        clientX: TRACK_HEADER_WIDTH + 100,
        clientY: RULER_HEIGHT + 10,
        buttons: 1,
      });
      latestTransformDragHandlersRef.current?.handleTransformDragStart(
        makeTransformDragStartEvent(),
      );
      latestTransformDragHandlersRef.current?.handleTransformDragEnd(
        makeTransformDragEndEvent(),
      );
    });

    const clip = useTimelineStore.getState().clips[0];
    expect(clip.transformations).toHaveLength(1);
    expect(clip.transformations[0]).toMatchObject({
      type: "filter",
      filterName: "BlurFilter",
      parameters: { strength: 0, quality: 4 },
    });
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["clip-video"]);
  });

  it("drops a compatible transformation on empty space and creates a five-second adjustment clip", () => {
    useTimelineStore.setState({
      tracks: [makeTrack("track-video", "visual")],
      clips: [],
      selectedClipIds: [],
    });

    render(<TestTransformDragApp />);

    const container = screen.getByTestId("timeline-container");
    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });

    act(() => {
      fireEvent.pointerMove(window, {
        clientX: TRACK_HEADER_WIDTH + 300,
        clientY: RULER_HEIGHT + 10,
        buttons: 1,
      });
      latestTransformDragHandlersRef.current?.handleTransformDragStart(
        makeTransformDragStartEvent(),
      );
      latestTransformDragHandlersRef.current?.handleTransformDragEnd(
        makeTransformDragEndEvent(),
      );
    });

    const adjustmentClip = useTimelineStore
      .getState()
      .clips.find((clip) => clip.type === "adjustment");
    expect(adjustmentClip).toBeTruthy();
    expect(adjustmentClip?.start).toBe(288000);
    expect(adjustmentClip?.timelineDuration).toBe(480000);
    expect(adjustmentClip?.transformations[0]).toMatchObject({
      type: "filter",
      filterName: "BlurFilter",
    });
    expect(useTimelineStore.getState().selectedClipIds).toEqual([
      adjustmentClip?.id,
    ]);
  });

  it("does nothing when dropping an incompatible transformation onto a clip", () => {
    useTimelineStore.setState({
      tracks: [makeTrack("track-audio", "audio")],
      clips: [audioClip("clip-audio", "track-audio")],
      selectedClipIds: [],
    });

    render(<TestTransformDragApp />);

    const container = screen.getByTestId("timeline-container");
    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });

    act(() => {
      fireEvent.pointerMove(window, {
        clientX: TRACK_HEADER_WIDTH + 100,
        clientY: RULER_HEIGHT + 10,
        buttons: 1,
      });
      latestTransformDragHandlersRef.current?.handleTransformDragStart(
        makeTransformDragStartEvent(),
      );
      latestTransformDragHandlersRef.current?.handleTransformDragEnd(
        makeTransformDragEndEvent(),
      );
    });

    const clip = useTimelineStore.getState().clips[0];
    expect(clip.transformations).toEqual([]);
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("targets the hovered (non-topmost) adjustment track on an empty middle drop", () => {
    useTimelineStore.setState({
      tracks: [
        makeTrack("adj-0", "adjustment"),
        makeTrack("adj-1", "adjustment"),
      ],
      clips: [],
      selectedClipIds: [],
    });

    render(<TestTransformDragApp />);

    const container = screen.getByTestId("timeline-container");
    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });

    act(() => {
      // Vertical middle of the second adjustment track (index 1).
      fireEvent.pointerMove(window, {
        clientX: TRACK_HEADER_WIDTH + 100,
        clientY: RULER_HEIGHT + 60 + 30,
        buttons: 1,
      });
      latestTransformDragHandlersRef.current?.handleTransformDragStart(
        makeTransformDragStartEvent(),
      );
      latestTransformDragHandlersRef.current?.handleTransformDragEnd(
        makeTransformDragEndEvent(),
      );
    });

    const state = useTimelineStore.getState();
    const adjustmentClips = state.clips.filter((c) => c.type === "adjustment");
    expect(adjustmentClips).toHaveLength(1);
    // The clip lands on the SECOND (hovered) adjustment lane, not the topmost.
    expect(adjustmentClips[0].trackId).toBe("adj-1");
    expect(adjustmentClips[0].start).toBe(96000);
    expect(state.tracks.some((t) => t.id === "adj-1")).toBe(true);
  });

  it("resolves collisions against existing adjustment clips on the lane", () => {
    // Existing clip occupies [480000, 960000]; the drop lands in the empty
    // gap to its left (tick 288000) but the 5s clip would overlap it, so it
    // must snap back to start 0 (obstacle.start - duration).
    useTimelineStore.setState({
      tracks: [makeTrack("adj-0", "adjustment")],
      clips: [adjustmentClip("adj-existing", "adj-0", 480000, 480000)],
      selectedClipIds: [],
    });

    render(<TestTransformDragApp />);

    const container = screen.getByTestId("timeline-container");
    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });

    act(() => {
      fireEvent.pointerMove(window, {
        clientX: TRACK_HEADER_WIDTH + 300,
        clientY: RULER_HEIGHT + 30,
        buttons: 1,
      });
      latestTransformDragHandlersRef.current?.handleTransformDragStart(
        makeTransformDragStartEvent(),
      );
      latestTransformDragHandlersRef.current?.handleTransformDragEnd(
        makeTransformDragEndEvent(),
      );
    });

    const adjustmentClips = useTimelineStore
      .getState()
      .clips.filter((c) => c.type === "adjustment");
    expect(adjustmentClips).toHaveLength(2);
    const created = adjustmentClips.find((c) => c.id !== "adj-existing");
    expect(created?.start).toBe(0);
    expect(created?.trackId).toBe("adj-0");
  });

  it("inserts a new adjustment track for an interstitial drop near a boundary", () => {
    useTimelineStore.setState({
      tracks: [makeTrack("track-video", "visual")],
      clips: [videoClip("clip-video", "track-video")],
      selectedClipIds: [],
    });

    render(<TestTransformDragApp />);

    const container = screen.getByTestId("timeline-container");
    mockRect(container, { left: 0, top: 0, width: 800, height: 600 });

    act(() => {
      // Bottom edge of the video lane, over empty horizontal space
      // (tick 288000 is past the clip's 192000 end) -> insert below.
      fireEvent.pointerMove(window, {
        clientX: TRACK_HEADER_WIDTH + 300,
        clientY: RULER_HEIGHT + 50,
        buttons: 1,
      });
      latestTransformDragHandlersRef.current?.handleTransformDragStart(
        makeTransformDragStartEvent(),
      );
      latestTransformDragHandlersRef.current?.handleTransformDragEnd(
        makeTransformDragEndEvent(),
      );
    });

    const state = useTimelineStore.getState();
    // A fresh adjustment lane was inserted (more than the single video track).
    expect(state.tracks.length).toBeGreaterThan(1);
    const created = state.clips.find((c) => c.type === "adjustment");
    expect(created?.start).toBe(288000);
    const lane = state.tracks.find((t) => t.id === created?.trackId);
    expect(lane?.type).toBe("adjustment");
    // The original video clip is untouched.
    expect(
      state.clips.find((c) => c.id === "clip-video")?.transformations,
    ).toEqual([]);
  });
});
