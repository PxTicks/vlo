import React from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineContainer } from "../TimelineContainer";
import { useTimelineStore } from "../useTimelineStore";
import { useTimelineClipsForTrack } from "../api";
import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  PROJECT_CURRENT_BEAT_AUDIO,
  buildLongTimelineFixture,
  type LongTimelineFixture,
} from "./fixtures/longTimelineFixture";
import { readProjectCurrentTimeline } from "./fixtures/longTimelineFixtureSource";

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
function middleVideoClip(): TimelineClip {
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
    loadFixture();
  });

  afterEach(() => {
    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot(null);
    });
  });

  it("mounts one timeline-clip node per non-mask clip", () => {
    renderTimeline();

    // Workstream B: bound this by the visible range plus overscan, selection
    // and the drag target, independent of timeline length.
    expect(screen.getAllByTestId("timeline-clip")).toHaveLength(
      nonMaskClips().length,
    );
  });

  it("re-renders every thumbnail clip after a one-clip commit", () => {
    renderTimeline();
    const mountedThumbnailClips = new Set(thumbnailRenders).size;
    expect(mountedThumbnailClips).toBeGreaterThan(0);
    thumbnailRenders.length = 0;

    act(() => {
      useTimelineStore.getState().toggleClipMute(middleVideoClip().id);
    });

    // Workstream B4 + A: only the edited clip (and clips whose presentation
    // changed) should render. Today the per-commit `timelineTime` prop and
    // the deep-cloned clips defeat `memo` for every clip.
    expect(new Set(thumbnailRenders).size).toBe(mountedThumbnailClips);
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
