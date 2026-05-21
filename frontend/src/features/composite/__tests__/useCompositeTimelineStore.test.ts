import { beforeEach, describe, expect, it, vi } from "vitest";
import { playbackClock } from "../../player/services/PlaybackClock";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { TICKS_PER_SECOND } from "../../timeline/constants";
import { useCompositeTimelineStore } from "../useCompositeTimelineStore";
import { createCompositeTimelineClip } from "../utils/createCompositeClip";
import type {
  CompositeTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";

const bakeMocks = vi.hoisted(() => ({
  scheduleCompositeProxyRender: vi.fn(),
}));

vi.mock("../services/renderCompositeProxyForClip", () => ({
  scheduleCompositeProxyRender: bakeMocks.scheduleCompositeProxyRender,
}));

const mainTrack: TimelineTrack = {
  id: "main-track",
  label: "Track 1",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

const innerTrack: TimelineTrack = {
  id: "inner-track",
  label: "Inner Track",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

const innerClip: TimelineClip = {
  id: "inner-clip",
  type: "image",
  name: "Inner Clip",
  trackId: innerTrack.id,
  start: 0,
  sourceDuration: TICKS_PER_SECOND,
  timelineDuration: TICKS_PER_SECOND,
  croppedSourceDuration: TICKS_PER_SECOND,
  offset: 0,
  transformedDuration: TICKS_PER_SECOND,
  transformedOffset: 0,
  transformations: [],
  assetId: "asset-inner",
};

function seedTimeline(clips: TimelineClip[], tracks: TimelineTrack[] = [mainTrack]) {
  useTimelineStore.getState().setTimelinePersistenceSuspended(false);
  useTimelineStore.getState().replaceTimelineSnapshot({ tracks, clips });
}

function resetCompositeStore() {
  useCompositeTimelineStore.setState({
    stack: [],
    isBusy: false,
    lastError: null,
  });
}

describe("useCompositeTimelineStore", () => {
  beforeEach(() => {
    bakeMocks.scheduleCompositeProxyRender.mockReset();
    resetCompositeStore();
    seedTimeline([]);
    playbackClock.setTime(0);
  });

  it("opens a composite clip as an editable subtimeline and saves edits back to the main timeline", async () => {
    const compositeClip = createCompositeTimelineClip({
      content: {
        durationTicks: TICKS_PER_SECOND,
        clips: [innerClip],
        tracks: [innerTrack],
      },
      trackId: mainTrack.id,
      start: 0,
      proxyAssetId: "old-proxy",
      proxyContentHash: "old-hash",
      name: "Composite",
    });
    seedTimeline([compositeClip]);

    expect(
      useCompositeTimelineStore.getState().openCompositeClip(compositeClip.id),
    ).toBe(true);

    expect(useTimelineStore.getState().clips.map((clip) => clip.id)).toEqual([
      innerClip.id,
    ]);

    const addedClip: TimelineClip = {
      ...innerClip,
      id: "added-inner-clip",
      start: TICKS_PER_SECOND,
    };
    useTimelineStore.getState().addClip(addedClip);

    await expect(
      useCompositeTimelineStore.getState().exitToMainTimeline(),
    ).resolves.toBe(true);

    const [savedClip] = useTimelineStore.getState().clips;
    expect(savedClip.id).toBe(compositeClip.id);
    expect(savedClip.type).toBe("composite");
    const savedComposite = savedClip as CompositeTimelineClip;
    expect(savedComposite.content.clips.map((clip) => clip.id)).toEqual([
      innerClip.id,
      addedClip.id,
    ]);
    expect(savedComposite.content.durationTicks).toBe(2 * TICKS_PER_SECOND);
    expect(savedComposite.proxyAssetId).toBe("old-proxy");
    expect(savedComposite.proxyContentHash).toBeUndefined();
    expect(bakeMocks.scheduleCompositeProxyRender).toHaveBeenCalledWith(
      compositeClip.id,
      expect.objectContaining({ durationTicks: 2 * TICKS_PER_SECOND }),
    );
    expect(useCompositeTimelineStore.getState().stack).toEqual([]);
  });

  it("creates a blank scene subtimeline and inserts it as a composite clip", async () => {
    playbackClock.setTime(12_000);
    seedTimeline([]);

    expect(useCompositeTimelineStore.getState().startBlankSubtimeline()).toBe(
      true,
    );
    expect(useTimelineStore.getState().clips).toEqual([]);

    useTimelineStore.getState().addClip({
      ...innerClip,
      trackId: useTimelineStore.getState().tracks[0].id,
    });

    await expect(
      useCompositeTimelineStore.getState().exitToMainTimeline(),
    ).resolves.toBe(true);

    const [sceneClip] = useTimelineStore.getState().clips;
    expect(sceneClip.type).toBe("composite");
    expect(sceneClip.name).toBe("Scene");
    expect(sceneClip.start).toBe(12_000);
    expect((sceneClip as CompositeTimelineClip).content.clips).toHaveLength(1);
    expect((sceneClip as CompositeTimelineClip).proxyAssetId).toBeUndefined();
    expect(bakeMocks.scheduleCompositeProxyRender).toHaveBeenCalledWith(
      sceneClip.id,
      expect.objectContaining({ clips: expect.any(Array) }),
    );
  });

  it("returns to the main timeline without inserting an untouched blank scene", async () => {
    playbackClock.setTime(12_000);
    seedTimeline([]);

    expect(useCompositeTimelineStore.getState().startBlankSubtimeline()).toBe(
      true,
    );

    await expect(
      useCompositeTimelineStore.getState().exitToMainTimeline(),
    ).resolves.toBe(true);

    expect(useTimelineStore.getState().clips).toEqual([]);
    expect(bakeMocks.scheduleCompositeProxyRender).not.toHaveBeenCalled();
  });
});
