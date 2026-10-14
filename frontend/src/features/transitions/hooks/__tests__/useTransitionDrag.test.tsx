import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import type {
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../project";
import { useInteractionStore } from "../../../timeline/hooks/useInteractionStore";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { useTimelineViewStore } from "../../../timeline/hooks/useTimelineViewStore";
import {
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
} from "../../../timeline/constants";
import type {
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../../types/TimelineTypes";
import { useTransitionDrag } from "../useTransitionDrag";

const SECOND = 96000;

const handlersRef: {
  current: ReturnType<typeof useTransitionDrag> | null;
} = { current: null };

const DISSOLVE_DRAG_DATA = {
  type: "transition",
  transitionType: "dissolve",
} as const;

function makeTrack(
  id: string,
  type: NonNullable<TimelineTrack["type"]> = "visual",
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

function videoClip(
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
    assetId: `${id}-asset`,
    start,
    timelineDuration: duration,
    sourceDuration: duration * 4,
    transformedDuration: duration * 4,
    transformedOffset: 0,
    croppedSourceDuration: duration * 4,
    offset: 0,
    transformations: [],
  };
}

function dragEvent<T>(data: unknown): T {
  return {
    active: { id: "transition_drag", data: { current: data } },
    over: null,
    delta: { x: 0, y: 0 },
    activatorEvent: null,
  } as unknown as T;
}

function TestApp() {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const handlers = useTransitionDrag(scrollContainerRef);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  return <div ref={scrollContainerRef} data-testid="timeline-container" />;
}

function mountTimeline() {
  render(<TestApp />);
  const container = screen.getByTestId("timeline-container");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 2000,
    height: 600,
    right: 2000,
    bottom: 600,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(container, "scrollLeft", {
    value: 0,
    configurable: true,
  });
  Object.defineProperty(container, "scrollTop", {
    value: 0,
    configurable: true,
  });
  return container;
}

/** Moves the tracked pointer to `tick` on the row `trackIndex`, `rowOffset` px down. */
function pointAt(tick: number, trackIndex: number, rowOffset = 10) {
  const x =
    TRACK_HEADER_WIDTH + useTimelineViewStore.getState().ticksToPx(tick);
  const y = RULER_HEIGHT + trackIndex * TRACK_HEIGHT + rowOffset;
  act(() => {
    fireEvent.pointerMove(window, { clientX: x, clientY: y, buttons: 1 });
  });
}

function move(data: unknown = DISSOLVE_DRAG_DATA) {
  act(() => {
    handlersRef.current?.handleTransitionDragMove(
      dragEvent<DragMoveEvent>(data),
    );
  });
  return useInteractionStore.getState().transitionDropPreview;
}

function drop(data: unknown = DISSOLVE_DRAG_DATA) {
  act(() => {
    handlersRef.current?.handleTransitionDragEnd(dragEvent<DragEndEvent>(data));
  });
  return useTimelineStore.getState();
}

function setTimeline(
  tracks: TimelineTrack[],
  clips: TimelineClip[],
  transitions: Transition[] = [],
) {
  useTimelineStore.setState({
    tracks,
    clips,
    transitions,
    selectedClipIds: [],
    selectedTransitionId: null,
  });
}

describe("useTransitionDrag", () => {
  beforeEach(() => {
    handlersRef.current = null;
    useInteractionStore.setState({ transitionDropPreview: null });
    useTimelineViewStore.setState({ zoomScale: 1 });
    useProjectStore.setState((state) => ({
      ...state,
      config: { ...state.config, fps: 30 },
    }));
  });

  it("previews and adds a transition across overlapping clips on adjacent visual tracks", () => {
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("late", "top", SECOND, 2 * SECOND),
        videoClip("early", "bottom", 0, 2 * SECOND),
      ],
    );
    mountTimeline();

    pointAt(1.5 * SECOND, 1);
    expect(move()).toEqual({
      startTick: SECOND,
      endTick: 2 * SECOND,
      topTrackIndex: 0,
      compatible: true,
    });

    const state = drop();
    expect(useInteractionStore.getState().transitionDropPreview).toBeNull();
    expect(state.transitions).toHaveLength(1);
    // The earlier-starting clip leaves; the later one enters.
    expect(state.transitions[0]).toMatchObject({
      type: "dissolve",
      outgoingClipId: "early",
      incomingClipId: "late",
    });
    expect(state.selectedTransitionId).toBe(state.transitions[0].id);
  });

  it("breaks equal-start ties by picking the earlier-ending clip as outgoing", () => {
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("long", "top", 0, 3 * SECOND),
        videoClip("short", "bottom", 0, SECOND),
      ],
    );
    mountTimeline();

    pointAt(0.5 * SECOND, 0, TRACK_HEIGHT - 10);
    const state = drop();
    expect(state.transitions[0]).toMatchObject({
      outgoingClipId: "short",
      incomingClipId: "long",
    });
  });

  it("pulls an abutting incoming clip back to create a default-length overlap", () => {
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("first", "top", 0, 2 * SECOND),
        videoClip("second", "bottom", 2 * SECOND, 2 * SECOND),
      ],
    );
    mountTimeline();

    pointAt(2 * SECOND, 1);
    const preview = move();
    // Half a second at 30 fps: 15 frames of 3200 ticks.
    expect(preview).toEqual({
      startTick: 1.5 * SECOND,
      endTick: 2 * SECOND,
      topTrackIndex: 0,
      compatible: true,
    });

    const state = drop();
    expect(state.transitions[0]).toMatchObject({
      outgoingClipId: "first",
      incomingClipId: "second",
    });
    expect(state.clips.find((clip) => clip.id === "second")?.start).toBe(
      1.5 * SECOND,
    );
  });

  it("refuses an abutting pair when the incoming clip cannot move earlier", () => {
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("first", "top", 0, 2 * SECOND),
        videoClip("blocker", "bottom", 0, 2 * SECOND),
        videoClip("second", "bottom", 2 * SECOND, 2 * SECOND),
      ],
    );
    mountTimeline();

    pointAt(2 * SECOND, 1);
    // "blocker" occupies the half second "second" would need to slide into.
    expect(move()).toBeNull();
    expect(drop().transitions).toEqual([]);
  });

  it("refuses pairs whose clips already belong to a transition", () => {
    const existing: Transition = {
      id: "transition_existing",
      type: "dissolve",
      outgoingClipId: "early",
      incomingClipId: "other",
      parameters: {},
    };
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("late", "top", SECOND, 2 * SECOND),
        videoClip("early", "bottom", 0, 2 * SECOND),
      ],
      [existing],
    );
    mountTimeline();

    pointAt(1.5 * SECOND, 1);
    expect(move()).toBeNull();
  });

  it("refuses abutting pairs whose clips already belong to a transition", () => {
    const existing: Transition = {
      id: "transition_existing",
      type: "dissolve",
      outgoingClipId: "elsewhere",
      incomingClipId: "second",
      parameters: {},
    };
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("first", "top", 0, 2 * SECOND),
        videoClip("second", "bottom", 2 * SECOND, 2 * SECOND),
      ],
      [existing],
    );
    mountTimeline();

    pointAt(2 * SECOND, 1);
    expect(move()).toBeNull();
  });

  it("ignores audio tracks and clips that do not meet at the cursor", () => {
    setTimeline(
      [makeTrack("top"), makeTrack("audio", "audio")],
      [
        videoClip("video", "top", 0, 2 * SECOND),
        videoClip("sound", "audio", 0, 2 * SECOND),
      ],
    );
    mountTimeline();
    pointAt(SECOND, 1);
    expect(move()).toBeNull();

    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("first", "top", 0, SECOND),
        videoClip("gap", "bottom", 3 * SECOND, SECOND),
      ],
    );
    pointAt(SECOND, 1);
    expect(move()).toBeNull();
  });

  it("rejects cursors outside the track body", () => {
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("late", "top", SECOND, 2 * SECOND),
        videoClip("early", "bottom", 0, 2 * SECOND),
      ],
    );
    mountTimeline();

    // Over the sticky track headers.
    act(() => {
      fireEvent.pointerMove(window, {
        clientX: TRACK_HEADER_WIDTH / 2,
        clientY: RULER_HEIGHT + TRACK_HEIGHT,
      });
    });
    expect(move()).toBeNull();

    // Below the last track row.
    pointAt(1.5 * SECOND, 5);
    expect(move()).toBeNull();
    expect(drop().transitions).toEqual([]);
  });

  it("does nothing until the pointer has been seen", () => {
    setTimeline([makeTrack("top"), makeTrack("bottom")], []);
    mountTimeline();
    expect(move()).toBeNull();
  });

  it("ignores non-transition drags and clears previews on start and cancel", () => {
    setTimeline(
      [makeTrack("top"), makeTrack("bottom")],
      [
        videoClip("late", "top", SECOND, 2 * SECOND),
        videoClip("early", "bottom", 0, 2 * SECOND),
      ],
    );
    mountTimeline();
    pointAt(1.5 * SECOND, 1);

    const stalePreview = {
      startTick: 1,
      endTick: 2,
      topTrackIndex: 0,
      compatible: true,
    };
    useInteractionStore.setState({ transitionDropPreview: stalePreview });
    expect(move({ type: "asset" })).toBe(stalePreview);
    expect(drop({ type: "asset" }).transitions).toEqual([]);
    expect(useInteractionStore.getState().transitionDropPreview).toBeNull();

    useInteractionStore.setState({ transitionDropPreview: stalePreview });
    act(() => {
      handlersRef.current?.handleTransitionDragStart(
        dragEvent<DragStartEvent>(DISSOLVE_DRAG_DATA),
      );
    });
    expect(useInteractionStore.getState().transitionDropPreview).toBeNull();

    useInteractionStore.setState({ transitionDropPreview: stalePreview });
    act(() => {
      handlersRef.current?.handleTransitionDragCancel(
        dragEvent<DragCancelEvent>(DISSOLVE_DRAG_DATA),
      );
    });
    expect(useInteractionStore.getState().transitionDropPreview).toBeNull();
  });
});
