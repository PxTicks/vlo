import { describe, expect, it } from "vitest";
import {
  compositeContentToSelection,
  hashCompositeContent,
  isCompositeProxyStale,
  selectionToCompositeContent,
} from "../composite";
import type {
  CompositeTimelineClip,
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

    const content = selectionToCompositeContent(selection);

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

    const content = selectionToCompositeContent(selection);

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

    const content = selectionToCompositeContent(selection);
    expect(content.clips[0].start).toBe(-400);
    expect(content.durationTicks).toBe(1000);
  });

  it("infers duration from clip extent when end is absent", () => {
    const selection: TimelineSelection = {
      start: 100,
      clips: [videoClip("a", 100, 700)],
    };
    expect(selectionToCompositeContent(selection).durationTicks).toBe(700);
  });

  it("round-trips content back to a zero-anchored selection", () => {
    const selection: TimelineSelection = {
      start: 500,
      end: 1500,
      clips: [videoClip("a", 500, 1000)],
      fps: 30,
    };

    const replayed = compositeContentToSelection(
      selectionToCompositeContent(selection),
    );

    expect(replayed.start).toBe(0);
    expect(replayed.end).toBe(1000);
    expect(replayed.clips[0].start).toBe(0);
    expect(replayed.fps).toBe(30);
  });

  it("hashes stably and changes when bake-affecting content changes", () => {
    const content = selectionToCompositeContent({
      start: 0,
      end: 1000,
      clips: [videoClip("a", 0, 1000)],
    });
    const same = selectionToCompositeContent({
      start: 0,
      end: 1000,
      clips: [videoClip("a", 0, 1000)],
    });
    expect(hashCompositeContent(content)).toBe(hashCompositeContent(same));

    const edited = selectionToCompositeContent({
      start: 0,
      end: 1000,
      clips: [videoClip("a", 0, 800)],
    });
    expect(hashCompositeContent(edited)).not.toBe(hashCompositeContent(content));
  });

  it("detects stale or unbaked proxies", () => {
    const content = selectionToCompositeContent({
      start: 0,
      end: 1000,
      clips: [videoClip("a", 0, 1000)],
    });
    const base: CompositeTimelineClip = {
      id: "composite-1",
      type: "composite",
      name: "Composite",
      trackId: "track-1",
      start: 0,
      sourceDuration: 1000,
      timelineDuration: 1000,
      croppedSourceDuration: 1000,
      offset: 0,
      transformedDuration: 1000,
      transformedOffset: 0,
      transformations: [],
      content,
    };

    expect(isCompositeProxyStale(base)).toBe(true);
    expect(
      isCompositeProxyStale({
        ...base,
        proxyAssetId: "proxy-1",
        proxyContentHash: hashCompositeContent(content),
      }),
    ).toBe(false);
    expect(
      isCompositeProxyStale({
        ...base,
        proxyAssetId: "proxy-1",
        proxyContentHash: "stale",
      }),
    ).toBe(true);
  });
});
