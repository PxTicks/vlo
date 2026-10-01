import React from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineContainer } from "../TimelineContainer";
import { useTimelineStore } from "../useTimelineStore";
import { useTimelineClipsForTrack } from "../api";
import type { TimelineClip, VideoTimelineClip } from "../../../types/TimelineTypes";
import {
  PROJECT_CURRENT_BEAT_AUDIO,
  buildLongTimelineFixture,
  type LongTimelineFixture,
} from "./fixtures/longTimelineFixture";
import { readProjectCurrentTimeline } from "./fixtures/longTimelineFixtureSource";
import { ticksToPx } from "../../../core/time/pixelGrid";
import { useInteractionStore } from "../hooks/useInteractionStore";

/**
 * Work counters for long timelines (docs/long-timeline-performance-plan.md,
 * workstream 0). They count work instead of timing it, so they are stable in
 * CI. Each bound documents today's behaviour; the workstream named beside it
 * is expected to tighten the assertion when it lands.
 */

const thumbnailRenders = vi.hoisted(() => [] as string[]);

vi.mock("../components/ThumbnailCanvas", () => ({
  // Not memoized, so it renders exactly when its clip component renders.
  ThumbnailCanvas: ({ clip }: { clip: { id: string } }) => {
    thumbnailRenders.push(clip.id);
    return null;
  },
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const REPETITIONS = 10;

let fixture: LongTimelineFixture;

function loadFixture(): void {
  fixture = buildLongTimelineFixture(readProjectCurrentTimeline(), {
    repetitions: REPETITIONS,
    audio: PROJECT_CURRENT_BEAT_AUDIO,
  });
  act(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: fixture.tracks,
      clips: fixture.clips,
      transitions: fixture.transitions,
    });
  });
}

function nonMaskClips(): TimelineClip[] {
  return useTimelineStore.getState().clips.filter((clip) => clip.type !== "mask");
}

/** A video clip in the middle of the timeline, away from both ends. */
function middleVideoClip(): VideoTimelineClip {
  const videos = nonMaskClips().filter((clip) => clip.type === "video");
  return videos[Math.floor(videos.length / 2)];
}

function renderTimeline() {
  return render(
    <TimelineContainer
      scrollContainerRef={React.createRef<HTMLDivElement>()}
      insertGapIndex={null}
    />,
  );
}

describe("long timeline work counters", () => {
  beforeEach(() => {
    thumbnailRenders.length = 0;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    loadFixture();
  });

  afterEach(() => {
    act(() => {
      useInteractionStore.getState().stopDrag();
      useTimelineStore.getState().replaceTimelineSnapshot(null);
    });
    vi.restoreAllMocks();
  });

  it("mounts clips in the viewport and mounts later clips when scrolled into view", async () => {
    renderTimeline();
    const laterClip = middleVideoClip();
    const container = screen.getByTestId("timeline-scroll-container");

    expect(screen.getAllByTestId("timeline-clip").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("timeline-clip").length).toBeLessThan(nonMaskClips().length);
    expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).toBeNull();

    container.scrollLeft = ticksToPx(laterClip.start, 1);
    fireEvent.scroll(container);

    await waitFor(() => {
      expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).not.toBeNull();
    });
    expect(screen.getAllByTestId("timeline-clip").length).toBeLessThan(nonMaskClips().length);
  });

  it("keeps a large selection virtualized until a move drag needs its followers", () => {
    renderTimeline();
    const laterClip = middleVideoClip();
    const firstClip = nonMaskClips().find(
      (clip): clip is VideoTimelineClip => clip.type === "video",
    )!;
    const container = screen.getByTestId("timeline-scroll-container");
    expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).toBeNull();

    act(() => useTimelineStore.setState({
      selectedClipIds: nonMaskClips().map((clip) => clip.id),
    }));
    expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).toBeNull();
    expect(screen.getAllByTestId("timeline-clip").length).toBeLessThan(nonMaskClips().length);

    act(() => useInteractionStore.getState().startDrag(firstClip.id, firstClip, "move"));
    expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).not.toBeNull();

    act(() => {
      useInteractionStore.getState().stopDrag();
      useTimelineStore.getState().selectClip(null);
    });
    expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).toBeNull();

    act(() => useInteractionStore.getState().startDrag(laterClip.id, laterClip, "resize_right"));
    expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).not.toBeNull();
  });

  it("places an off-screen selected follower at the drag offset when it mounts", () => {
    renderTimeline();
    const laterClip = middleVideoClip();
    const firstClip = nonMaskClips().find(
      (clip): clip is VideoTimelineClip => clip.type === "video",
    )!;
    const container = screen.getByTestId("timeline-scroll-container");
    act(() => useTimelineStore.setState({
      selectedClipIds: [firstClip.id, laterClip.id],
    }));
    expect(container.querySelector(`[data-clip-id="${laterClip.id}"]`)).toBeNull();

    // The follower mounts in the same render that sees the delta, so its
    // mount-time sync must place it rather than a later delta update.
    act(() => {
      useInteractionStore.getState().startDrag(firstClip.id, firstClip, "move");
      useInteractionStore.getState().updateDelta(120, 0);
    });
    const follower = container.querySelector<HTMLElement>(
      `[data-clip-id="${laterClip.id}"]`,
    );
    expect(follower?.style.transform).toBe("translate3d(120px, 0px, 0)");

    act(() => useInteractionStore.getState().updateDelta(200, 0));
    expect(follower?.style.transform).toBe("translate3d(200px, 0px, 0)");
  });

  it("mounts only transitions overlapping the visible window", () => {
    renderTimeline();
    const mountedTransitions = document.querySelectorAll(
      '[data-testid^="transition-overlay-"]',
    ).length;

    expect(fixture.transitions.length).toBeGreaterThan(1);
    expect(mountedTransitions).toBeGreaterThan(0);
    expect(mountedTransitions).toBeLessThan(fixture.transitions.length);
  });

  it("re-renders every thumbnail clip after a one-clip commit", () => {
    renderTimeline();
    const mountedThumbnailClips = new Set(thumbnailRenders).size;
    expect(mountedThumbnailClips).toBeGreaterThan(0);
    thumbnailRenders.length = 0;

    act(() => {
      useTimelineStore.getState().toggleClipMute(middleVideoClip().id);
    });

    // Workstream A: the commit deep-clones every clip, so every mounted clip
    // gets a new `clip` prop. B4 already keeps the other props stable.
    expect(new Set(thumbnailRenders).size).toBe(mountedThumbnailClips);
  });

  it("re-renders only the edited clip after a structurally shared update", () => {
    renderTimeline();
    const mounted = new Set(thumbnailRenders);
    expect(mounted.size).toBeGreaterThan(1);
    const edited = nonMaskClips().find((clip) => mounted.has(clip.id))!;
    thumbnailRenders.length = 0;

    // The shape workstream A's commits will produce: one new clip object,
    // every other clip and the tracks array kept by identity.
    act(() => {
      useTimelineStore.setState((state) => ({
        clips: state.clips.map((clip) =>
          clip.id === edited.id ? { ...clip, name: `${clip.name} (edited)` } : clip,
        ),
      }));
    });

    expect([...new Set(thumbnailRenders)]).toEqual([edited.id]);
  });

  it("re-renders only the clips whose selection changed", () => {
    renderTimeline();
    const mounted = nonMaskClips().filter((clip) => thumbnailRenders.includes(clip.id));
    expect(mounted.length).toBeGreaterThan(2);
    const [first, second] = mounted;
    act(() => useTimelineStore.getState().selectClip(first.id));
    thumbnailRenders.length = 0;

    act(() => useTimelineStore.getState().selectClip(second.id));

    expect(new Set(thumbnailRenders)).toEqual(new Set([first.id, second.id]));
  });

  it("replaces other tracks' clip arrays on a one-clip commit", () => {
    const edited = middleVideoClip();
    const otherTrackId = fixture.tracks.find(
      (track) =>
        track.id !== edited.trackId &&
        fixture.clips.some((clip) => clip.trackId === track.id),
    )!.id;
    const { result } = renderHook(() => useTimelineClipsForTrack(otherTrackId));
    const before = result.current;

    act(() => {
      useTimelineStore.getState().toggleClipMute(edited.id);
    });

    // Workstream A (A6): an untouched track keeps its array, so
    // useTrackRenderEngine skips re-deriving and requesting a paused frame.
    expect(result.current).not.toBe(before);
    expect(result.current).toEqual(before);
  });

  it("retains whole-timeline patches in a one-clip undo entry", () => {
    act(() => {
      useTimelineStore.getState().toggleClipMute(middleVideoClip().id);
    });

    const { undoEntries } = useTimelineStore.getState().getHistoryDiagnostics();
    const clipsBytes = JSON.stringify(useTimelineStore.getState().clips).length;

    expect(undoEntries).toHaveLength(1);
    // Workstream A (A4): path patches, a few kilobytes for this edit. Today
    // each side of the entry is a root `replace` of the whole clips array.
    expect(undoEntries[0].forwardPatchCount).toBe(1);
    expect(undoEntries[0].inversePatchCount).toBe(1);
    expect(undoEntries[0].patchJsonBytes).toBeGreaterThan(2 * clipsBytes * 0.9);
  });

  it("reports undo patch size in UTF-8 bytes, not UTF-16 code units", () => {
    const edited = middleVideoClip();
    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: fixture.tracks,
        clips: fixture.clips.map((clip) =>
          clip.id === edited.id ? { ...clip, name: "Überblende 🎬".repeat(1000) } : clip,
        ),
        transitions: fixture.transitions,
      });
      useTimelineStore.getState().toggleClipMute(edited.id);
    });

    const clipsJson = JSON.stringify(useTimelineStore.getState().clips);
    const [entry] = useTimelineStore.getState().getHistoryDiagnostics().undoEntries;

    // Both sides of the entry carry the whole clips array (see above).
    expect(entry.patchJsonBytes).toBeGreaterThanOrEqual(
      2 * new TextEncoder().encode(clipsJson).byteLength,
    );
  });
});
