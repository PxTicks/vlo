import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StandardTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { TimelineMarquee } from "../../components/TimelineMarquee";
import { useTimelineStore } from "../../useTimelineStore";
import { useTimelineViewStore } from "../useTimelineViewStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { cancelTimelineInteractions } from "../../cancelTimelineInteractions";
import { resetZustandStore } from "../../../../testUtils/zustand";
import {
  RULER_HEIGHT,
  TICKS_PER_SECOND,
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
} from "../../constants";

function createTrack(id: string): TimelineTrack {
  return { id, label: id, isVisible: true, isLocked: false, isMuted: false };
}

function createClip(
  id: string,
  trackId: string,
  startSeconds: number,
  durationSeconds: number,
): StandardTimelineClip {
  const duration = durationSeconds * TICKS_PER_SECOND;
  return {
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `asset_${id}`,
    start: startSeconds * TICKS_PER_SECOND,
    timelineDuration: duration,
    offset: 0,
    croppedSourceDuration: duration,
    transformedOffset: 0,
    sourceDuration: duration,
    transformedDuration: duration,
    transformations: [],
  } as StandardTimelineClip;
}

/** Client x of a timeline second (the container sits at the viewport origin). */
function xAt(seconds: number): number {
  return (
    TRACK_HEADER_WIDTH +
    useTimelineViewStore.getState().ticksToPx(seconds * TICKS_PER_SECOND)
  );
}

/** Client y in the middle of a track row. */
function yAt(trackIndex: number): number {
  return RULER_HEIGHT + trackIndex * TRACK_HEIGHT + TRACK_HEIGHT / 2;
}

const onContainerClick = vi.fn(() => {
  useTimelineStore.getState().selectClip(null);
});

function Harness({ onActivate }: { onActivate?: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="scroll" onClick={onContainerClick}>
      <div data-timeline-marquee-surface data-testid="surface">
        <div data-testid="timeline-body" />
        <div data-testid="timeline-body" />
        <div data-testid="some-clip" />
        <TimelineMarquee
          scrollContainerRef={scrollRef}
          onActivate={onActivate}
        />
      </div>
    </div>
  );
}

function renderHarness(onActivate?: () => void) {
  const result = render(<Harness onActivate={onActivate} />);
  const container = screen.getByTestId("scroll");
  container.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 4000,
      bottom: 600,
      width: 4000,
      height: 600,
    }) as DOMRect;
  Object.defineProperty(container, "scrollWidth", { value: 100_000 });
  Object.defineProperty(container, "scrollHeight", { value: 1_000 });
  return result;
}

function drag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: { shiftKey?: boolean } = {},
) {
  const body = screen.getAllByTestId("timeline-body")[0];
  fireEvent.pointerDown(body, {
    button: 0,
    pointerId: 1,
    clientX: from.x,
    clientY: from.y,
    ...modifiers,
  });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y });
}

function release(at: { x: number; y: number }) {
  fireEvent.pointerUp(window, { pointerId: 1, clientX: at.x, clientY: at.y });
  fireEvent.click(screen.getByTestId("surface"));
}

describe("useTimelineMarquee", () => {
  beforeEach(() => {
    onContainerClick.mockClear();
    useTimelineStore.setState({
      tracks: [createTrack("t1"), createTrack("t2")],
      clips: [
        createClip("a", "t1", 0, 2),
        createClip("b", "t2", 4, 2),
        createClip("c", "t1", 10, 2),
      ],
      selectedClipIds: [],
      selectedTransitionId: null,
    });
  });

  afterEach(() => {
    resetZustandStore(useTimelineStore);
    resetZustandStore(useTimelineSelectionStore);
  });

  it("selects the clips under the dragged box and keeps them after release", () => {
    const onActivate = vi.fn();
    renderHarness(onActivate);

    drag({ x: xAt(1), y: yAt(0) }, { x: xAt(5), y: yAt(1) });

    expect(screen.getByTestId("timeline-marquee")).toBeInTheDocument();
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["a", "b"]);
    expect(onActivate).toHaveBeenCalledTimes(1);

    release({ x: xAt(5), y: yAt(1) });

    expect(screen.queryByTestId("timeline-marquee")).toBeNull();
    // The click after the drag must not reach the container's deselect/seek.
    expect(onContainerClick).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["a", "b"]);
  });

  it("updates the selection live as the box shrinks", () => {
    renderHarness();

    drag({ x: xAt(1), y: yAt(0) }, { x: xAt(11), y: yAt(1) });
    expect(useTimelineStore.getState().selectedClipIds).toEqual([
      "a",
      "b",
      "c",
    ]);

    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: xAt(3),
      clientY: yAt(0),
    });
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["a"]);
  });

  it("leaves a plain click on empty space to the container", () => {
    useTimelineStore.setState({ selectedClipIds: ["a"] });
    renderHarness();

    drag({ x: xAt(1), y: yAt(0) }, { x: xAt(1) + 1, y: yAt(0) });
    expect(screen.queryByTestId("timeline-marquee")).toBeNull();
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["a"]);

    release({ x: xAt(1) + 1, y: yAt(0) });
    expect(onContainerClick).toHaveBeenCalledTimes(1);
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("adds to the existing selection when shift is held", () => {
    useTimelineStore.setState({ selectedClipIds: ["c"] });
    renderHarness();

    drag(
      { x: xAt(1), y: yAt(0) },
      { x: xAt(5), y: yAt(1) },
      { shiftKey: true },
    );

    expect(useTimelineStore.getState().selectedClipIds).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("restores the original selection on Escape", () => {
    useTimelineStore.setState({ selectedClipIds: ["c"] });
    renderHarness();

    drag({ x: xAt(1), y: yAt(0) }, { x: xAt(5), y: yAt(1) });
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["a", "b"]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("timeline-marquee")).toBeNull();
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["c"]);

    // Further movement is ignored, and the release still isn't a click.
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: xAt(11),
      clientY: yAt(0),
    });
    release({ x: xAt(11), y: yAt(0) });
    expect(onContainerClick).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["c"]);
  });

  it("restores a previously selected transition on Escape", () => {
    useTimelineStore.setState({
      transitions: [
        {
          id: "tr1",
          type: "crossfade",
          outgoingClipId: "a",
          incomingClipId: "b",
          parameters: {},
        },
      ],
      selectedClipIds: [],
      selectedTransitionId: "tr1",
    });
    renderHarness();

    drag({ x: xAt(1), y: yAt(0) }, { x: xAt(5), y: yAt(1) });
    expect(useTimelineStore.getState().selectedTransitionId).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTimelineStore.getState().selectedTransitionId).toBe("tr1");
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("follows timeline edits made while the marquee is held", () => {
    useTimelineStore.setState({ selectedClipIds: ["c"] });
    renderHarness();

    drag(
      { x: xAt(1), y: yAt(0) },
      { x: xAt(5), y: yAt(1) },
      { shiftKey: true },
    );
    expect(useTimelineStore.getState().selectedClipIds).toEqual([
      "c",
      "a",
      "b",
    ]);

    // A keyboard delete mid-gesture: the next move must not resurrect the
    // removed ids from footprints cached at activation.
    act(() => {
      useTimelineStore.setState((state) => ({
        clips: state.clips.filter((clip) => !["a", "c"].includes(clip.id)),
      }));
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: xAt(5) + 1,
      clientY: yAt(1),
    });
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["b"]);

    // A clip that appears under the box (undo, paste) is picked up at once.
    act(() => {
      useTimelineStore.setState((state) => ({
        clips: [...state.clips, createClip("d", "t1", 2, 1)],
      }));
    });
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["d", "b"]);

    // Escape never restores clips that no longer exist.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("ends when timeline interactions are cancelled", () => {
    renderHarness();

    drag({ x: xAt(1), y: yAt(0) }, { x: xAt(5), y: yAt(1) });
    act(() => cancelTimelineInteractions());

    expect(screen.queryByTestId("timeline-marquee")).toBeNull();
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: xAt(11),
      clientY: yAt(1),
    });
    expect(useTimelineStore.getState().selectedClipIds).toEqual(["a", "b"]);
  });

  it("does not start from a clip or other occupied element", () => {
    renderHarness();

    fireEvent.pointerDown(screen.getByTestId("some-clip"), {
      button: 0,
      pointerId: 1,
      clientX: xAt(1),
      clientY: yAt(0),
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: xAt(5),
      clientY: yAt(1),
    });

    expect(screen.queryByTestId("timeline-marquee")).toBeNull();
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("starts from the empty track area below the last row", () => {
    renderHarness();

    fireEvent.pointerDown(screen.getByTestId("surface"), {
      button: 0,
      pointerId: 1,
      clientX: xAt(5),
      clientY: yAt(3),
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: xAt(1),
      clientY: yAt(1),
    });

    expect(useTimelineStore.getState().selectedClipIds).toEqual(["b"]);
  });

  it("stays out of the way of the generation range picker", () => {
    useTimelineSelectionStore.setState({ selectionMode: true });
    renderHarness();

    drag({ x: xAt(1), y: yAt(0) }, { x: xAt(5), y: yAt(1) });

    expect(screen.queryByTestId("timeline-marquee")).toBeNull();
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });
});
