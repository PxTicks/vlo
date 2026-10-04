import { describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineTrack } from "../../../../types/TimelineTypes";
import { getTimelineTime, presentationTick, sourceTick, timelinePresentationRange } from "../index";
import { AdjustmentEffectResolver } from "../../../renderer/services/AdjustmentEffectResolver";

const tracks: TimelineTrack[] = [
  { id: "adjustment", type: "adjustment", label: "A", isVisible: true, isMuted: false, isLocked: false },
  { id: "video", type: "visual", label: "V", isVisible: true, isMuted: false, isLocked: false },
];
const clips: TimelineClip[] = [
  { id: "speed", trackId: "adjustment", type: "adjustment", name: "Speed", start: 0, timelineDuration: 50, offset: 0, sourceDuration: 100, croppedSourceDuration: 100, transformedDuration: 50, transformedOffset: 0, depth: 1, retimingMode: "ripple", transformations: [{ id: "speed-transform", type: "speed", isEnabled: true, parameters: { factor: 2 } }] },
  { id: "clip", trackId: "video", type: "video", name: "Clip", assetId: "asset", start: 100, timelineDuration: 100, offset: 10, sourceDuration: 200, croppedSourceDuration: 100, transformedDuration: 200, transformedOffset: 10, transformations: [] },
];
const snapshot = { tracks, clips, fps: 96000 };

describe("TimelineTime", () => {
  it("agrees with the renderer on identity, footprint and displayed source", () => {
    const time = getTimelineTime(snapshot);
    const renderer = new AdjustmentEffectResolver();
    renderer.setAdjustmentSource(tracks, clips, snapshot.fps);
    expect(renderer.getPresentationLookup()).toBe(time.renderLookup());
    const presentationIndex = time.presentationIndex();
    expect(time.presentationIndex()).toBe(presentationIndex);
    expect(presentationIndex.get("clip")).toBe(
      time.renderLookup().getPresentation("clip"),
    );
    expect(time.footprint("clip")).toEqual({ start: 50, end: 150 });
    for (let tick = 50; tick < 150; tick++) {
      const active = renderer.getPresentationLookup().findActiveClipAt("video", tick)!;
      expect(time.clipsAt(presentationTick(tick), { trackIds: ["video"] }).map((clip) => clip.id)).toEqual([active.clipId]);
      expect(time.toStored("clip", presentationTick(tick))).toBe(active.effectiveTick);
      expect(time.sourceAt("clip", presentationTick(tick))).toBe(tick - 50 + 10);
      expect(time.presentationOf("clip", sourceTick(tick - 50 + 10))).toBe(tick);
    }
    expect(time.clipsIn(timelinePresentationRange(150, 151))).toEqual([]);
    expect(time.footprint("missing")).toBeNull();
  });

  it("reuses one lookup without cloning during repeated authoring/playback reads", () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const first = getTimelineTime(snapshot);
      for (let i = 0; i < 1000; i++) {
        const time = getTimelineTime({ ...snapshot });
        expect(time).toBe(first);
        expect(time.renderLookup()).toBe(first.renderLookup());
        time.sourceAt("clip", presentationTick(75));
      }
      expect(clone).not.toHaveBeenCalled();
      expect(getTimelineTime({ ...snapshot, clips: [...clips] })).not.toBe(first);
    } finally { clone.mockRestore(); }
  });

  it("keeps presentation entries whose placement inputs are unchanged", () => {
    const freeTrack: TimelineTrack = { id: "free", type: "visual", label: "F", isVisible: true, isMuted: false, isLocked: false };
    const still = { ...clips[1], id: "still", trackId: "free", start: 0 } as TimelineClip;
    const base = { tracks: [...tracks, freeTrack], clips: [...clips, still], fps: 96000 };
    const entry = (time: ReturnType<typeof getTimelineTime>, id: string) => time.presentationIndex().get(id);
    const first = getTimelineTime(base);

    // A structurally shared commit that renames a clip keeps every entry.
    const renamed = getTimelineTime({ ...base, clips: base.clips.map((clip) => clip.id === "clip" ? { ...clip, name: "Renamed" } : clip) });
    expect(renamed).not.toBe(first);
    expect(entry(renamed, "clip")).toBe(entry(first, "clip"));
    expect(entry(renamed, "still")).toBe(entry(first, "still"));

    // A deep clone, which is what every commit produces today, keeps them too.
    const cloned = getTimelineTime(structuredClone(base));
    expect(entry(cloned, "clip")).toBe(entry(first, "clip"));
    expect(entry(cloned, "still")).toBe(entry(first, "still"));

    // Retiming the adjustment above "clip" rebuilds only the clips it reaches.
    const retimed = getTimelineTime({ ...base, clips: base.clips.map((clip) => clip.id === "speed" ? { ...clip, transformations: [{ id: "speed-transform", type: "speed", isEnabled: true, parameters: { factor: 4 } }] } as TimelineClip : clip) });
    expect(entry(retimed, "clip")).not.toBe(entry(first, "clip"));
    expect(entry(retimed, "still")).toBe(entry(first, "still"));

    const moved = getTimelineTime({ ...base, clips: base.clips.map((clip) => clip.id === "still" ? { ...clip, start: 48000 } : clip) });
    expect(entry(moved, "still")).not.toBe(entry(first, "still"));
    expect(moved.footprint("still")).toEqual({ start: 48000, end: 48100 });

    const refps = getTimelineTime({ ...base, fps: 48000 });
    expect(entry(refps, "still")).not.toBe(entry(moved, "still"));
  });

  it("explicitly isolates mappings from a multi-step draft mutation", () => {
    const draft = structuredClone(snapshot);
    const pinned = getTimelineTime(draft).snapshot();
    draft.clips[1].start = 300;
    expect(pinned.footprint("clip")).toEqual({ start: 50, end: 150 });
    expect(pinned.sourceAt("clip", presentationTick(75))).toBe(35);
  });
});
