import { describe, expect, it } from "vitest";
import {
  compositeContentToSelection,
  hashCompositeContent,
  renamespaceCompositeContentTracks,
  selectionToCompositeContent,
} from "../composite";
import { TICKS_PER_SECOND } from "../../../timeline";

// One tick per frame -> quantization is identity on the abstract tick fixtures.
const GRID_FPS = TICKS_PER_SECOND;
import type {
  AdjustmentTimelineClip,
  TimelineSelection,
  VideoTimelineClip,
} from "../../../../types/TimelineTypes";

function videoClip(
  id: string,
  start: number,
  timelineDuration: number,
): VideoTimelineClip {
  return {
    id,
    type: "video",
    name: id,
    assetId: `asset-${id}`,
    sourceDuration: timelineDuration,
    transformedDuration: timelineDuration,
    transformedOffset: 0,
    timelineDuration,
    croppedSourceDuration: timelineDuration,
    offset: 0,
    transformations: [],
    trackId: "track-1",
    start,
  };
}

describe("composite adapters", () => {
  it("shifts clips to local zero and derives duration from the window", () => {
    const selection: TimelineSelection = {
      start: 500,
      end: 1500,
      clips: [videoClip("a", 500, 1000), videoClip("b", 800, 400)],
      fps: 24,
      frameStep: 4,
    };

    const content = selectionToCompositeContent(selection, GRID_FPS);

    expect(content.durationTicks).toBe(1000);
    expect(content.clips.map((clip) => clip.start)).toEqual([0, 300]);
    expect(content.fps).toBe(24);
    expect(content.frameStep).toBe(4);
  });

  it("deep-clones captured clips and tracks so content edits are isolated", () => {
    const selection: TimelineSelection = {
      start: 500,
      end: 1500,
      clips: [videoClip("a", 500, 1000)],
      tracks: [
        {
          id: "track-1",
          type: "visual",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
    };

    const content = selectionToCompositeContent(selection, GRID_FPS);

    expect(content.clips[0]).not.toBe(selection.clips[0]);
    expect(content.tracks?.[0]).not.toBe(selection.tracks?.[0]);
    content.clips[0].transformations.push({
      id: "transform-1",
      type: "blur",
      isEnabled: true,
      parameters: {},
    });

    expect(selection.clips[0].transformations).toHaveLength(0);
  });

  it("keeps a negative start for a clip that began before the window", () => {
    const selection: TimelineSelection = {
      start: 1000,
      end: 2000,
      clips: [videoClip("a", 600, 2000)],
    };

    const content = selectionToCompositeContent(selection, GRID_FPS);
    expect(content.clips[0].start).toBe(-400);
    expect(content.durationTicks).toBe(1000);
  });

  it("infers duration from clip extent when end is absent", () => {
    const selection: TimelineSelection = {
      start: 100,
      clips: [videoClip("a", 100, 700)],
    };
    expect(selectionToCompositeContent(selection, GRID_FPS).durationTicks).toBe(
      700,
    );
  });

  it("infers presentation-aware duration when a slow adjustment is in the window", () => {
    // 0.5x adjustment over source window [0, 100) stretches a 150-tick clip's
    // tail out to presentation 250; raw stored ends would report only 200.
    const adjustment: AdjustmentTimelineClip = {
      id: "adj",
      type: "adjustment",
      name: "adj",
      trackId: "track-adj",
      start: 0,
      timelineDuration: 200,
      sourceDuration: 100,
      transformedDuration: 200,
      transformedOffset: 0,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [
        {
          id: "speed",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 0.5 },
        },
      ],
      depth: 1,
    };
    const selection: TimelineSelection = {
      start: 0,
      clips: [adjustment, videoClip("a", 0, 150)],
      tracks: [
        {
          id: "track-adj",
          type: "adjustment",
          label: "Adj",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
        {
          id: "track-1",
          type: "visual",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
    };

    expect(selectionToCompositeContent(selection, GRID_FPS).durationTicks).toBe(
      250,
    );
  });

  it("round-trips content back to a zero-anchored selection", () => {
    const selection: TimelineSelection = {
      start: 500,
      end: 1500,
      clips: [videoClip("a", 500, 1000)],
      fps: 30,
    };

    const replayed = compositeContentToSelection(
      selectionToCompositeContent(selection, GRID_FPS),
    );

    expect(replayed.start).toBe(0);
    expect(replayed.end).toBe(1000);
    expect(replayed.clips[0].start).toBe(0);
    expect(replayed.fps).toBe(30);
  });

  it("hashes stably and changes when bake-affecting content changes", () => {
    const content = selectionToCompositeContent(
      {
        start: 0,
        end: 1000,
        clips: [videoClip("a", 0, 1000)],
      },
      GRID_FPS,
    );
    const same = selectionToCompositeContent(
      {
        start: 0,
        end: 1000,
        clips: [videoClip("a", 0, 1000)],
      },
      GRID_FPS,
    );
    expect(hashCompositeContent(content)).toBe(hashCompositeContent(same));

    const edited = selectionToCompositeContent(
      {
        start: 0,
        end: 1000,
        clips: [videoClip("a", 0, 800)],
      },
      GRID_FPS,
    );
    expect(hashCompositeContent(edited)).not.toBe(
      hashCompositeContent(content),
    );
  });

  it("includes adjustment reach and extension payload in the content hash", () => {
    const adjustment: AdjustmentTimelineClip = {
      id: "adjustment",
      type: "adjustment",
      name: "Adjustment",
      trackId: "adjustment-track",
      start: 0,
      timelineDuration: 1000,
      sourceDuration: 1000,
      croppedSourceDuration: 1000,
      transformedDuration: 1000,
      transformedOffset: 0,
      offset: 0,
      transformations: [],
      depth: 1,
    };
    const extension = {
      id: "extension",
      type: "extension" as const,
      name: "Extension",
      trackId: "track-1",
      start: 0,
      timelineDuration: 1000,
      sourceDuration: null,
      croppedSourceDuration: 1000,
      transformedDuration: 1000,
      transformedOffset: 0,
      offset: 0,
      transformations: [],
      extensionPayload: {
        extensionId: "example.shapes",
        typeId: "star",
        schemaVersion: 1,
        data: { points: 5 },
      },
    };
    const base = {
      clips: [adjustment, extension],
      durationTicks: 1000,
    };

    expect(
      hashCompositeContent({
        ...base,
        clips: [{ ...adjustment, depth: 2 }, extension],
      }),
    ).not.toBe(hashCompositeContent(base));
    expect(
      hashCompositeContent({
        ...base,
        clips: [
          adjustment,
          {
            ...extension,
            extensionPayload: {
              ...extension.extensionPayload,
              data: { points: 8 },
            },
          },
        ],
      }),
    ).not.toBe(hashCompositeContent(base));
  });

  it("re-namespaces content track ids so they never collide with the parent timeline", () => {
    const parentTrackId = "track_parent";
    const content = selectionToCompositeContent(
      {
        start: 0,
        end: 1000,
        clips: [
          // Two clips share the parent's track id, plus a mask on the same track.
          videoClip("a", 0, 1000),
          {
            ...videoClip("b", 0, 1000),
            trackId: parentTrackId,
          },
          {
            id: "clip-mask",
            type: "mask",
            name: "Mask 1",
            trackId: parentTrackId,
            parentClipId: "b",
            start: 0,
            sourceDuration: 1000,
            timelineDuration: 1000,
            croppedSourceDuration: 1000,
            offset: 0,
            transformedDuration: 1000,
            transformedOffset: 0,
            transformations: [],
            maskType: "circle",
            maskMode: "apply",
            maskInverted: false,
            maskParameters: { baseWidth: 1, baseHeight: 1 },
          },
        ],
        tracks: [
          {
            id: "track-1",
            type: "visual",
            label: "Track 1",
            isVisible: true,
            isMuted: false,
            isLocked: false,
          },
          {
            id: parentTrackId,
            type: "visual",
            label: "Track 2",
            isVisible: true,
            isMuted: false,
            isLocked: false,
          },
        ],
        includedTrackIds: ["track-1", parentTrackId],
      },
      GRID_FPS,
    );

    const renamed = renamespaceCompositeContentTracks(content);

    const oldTrackIds = new Set(["track-1", parentTrackId]);
    const newTrackIds = new Set((renamed.tracks ?? []).map((t) => t.id));

    // No new track id reuses an old (parent timeline) id.
    for (const id of newTrackIds) {
      expect(oldTrackIds.has(id)).toBe(false);
    }
    expect(newTrackIds.size).toBe(2);

    // Every clip now points at a real, re-namespaced track.
    for (const clip of renamed.clips) {
      expect(newTrackIds.has(clip.trackId)).toBe(true);
    }

    // The mask stays on the same (new) track as its parent clip "b".
    const parentB = renamed.clips.find((c) => c.id === "b");
    const mask = renamed.clips.find((c) => c.id === "clip-mask");
    expect(mask?.trackId).toBe(parentB?.trackId);

    // Clip ids are untouched; includedTrackIds is remapped consistently.
    expect(renamed.clips.map((c) => c.id)).toEqual(["a", "b", "clip-mask"]);
    expect(renamed.includedTrackIds).toEqual(
      (renamed.tracks ?? []).map((t) => t.id),
    );
  });

  it("returns content unchanged when it carries no tracks", () => {
    const content = selectionToCompositeContent(
      { start: 0, end: 1000, clips: [videoClip("a", 0, 1000)] },
      GRID_FPS,
    );
    expect(renamespaceCompositeContentTracks(content)).toBe(content);
  });

});
