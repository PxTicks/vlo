import { useEffect, useRef } from "react";
import type { Input } from "mediabunny";
import { useTimelineClipsForTrack } from "../../timeline";
import { useAssetStore } from "../../userAssets";
import { usePlayerStore } from "../../player/usePlayerStore";
import { audioSystem } from "../../player/services/AudioSystem";
import { TrackAudioRenderer } from "../services/TrackAudioRenderer";
import type { AdjustmentEffectResolver } from "../services/AdjustmentEffectResolver";
import { sortTrackClipsByStart } from "../utils/clipLookup";
import { resolveRenderableAudioClipLanes } from "../utils/resolveRenderableClip";
import type { TimelineClip } from "../../../types/TimelineTypes";

const SHARED_LOOKAHEAD_SECONDS = 2.0;
const SHARED_SCHEDULER_INTERVAL_MS = 50;

interface SharedAudioTrackEntry {
  renderer: TrackAudioRenderer;
  trackClips: TimelineClip[];
  getInput: (assetId: string) => Promise<Input | null>;
  lastStartTime: number;
}

const sharedTrackEntries = new Map<string, SharedAudioTrackEntry>();
let sharedSchedulerActive = false;
let sharedSchedulerTimeout: ReturnType<typeof setTimeout> | null = null;

function clearSharedSchedulerTimeout() {
  if (sharedSchedulerTimeout === null) return;
  clearTimeout(sharedSchedulerTimeout);
  sharedSchedulerTimeout = null;
}

function stopSharedSchedulerLoop() {
  sharedSchedulerActive = false;
  clearSharedSchedulerTimeout();
}

function maybeStopSharedSchedulerLoop() {
  if (sharedTrackEntries.size > 0 && usePlayerStore.getState().isPlaying) {
    return;
  }
  stopSharedSchedulerLoop();
}

async function runSharedSchedulerTick() {
  if (!sharedSchedulerActive) return;

  if (sharedTrackEntries.size === 0 || !usePlayerStore.getState().isPlaying) {
    stopSharedSchedulerLoop();
    return;
  }

  const ctx = audioSystem.getContext();
  const master = audioSystem.getMasterGain();

  if (ctx && master) {
    const currentStartTime = audioSystem.getStartTime();
    const prioritizedEntries = Array.from(sharedTrackEntries.values()).sort(
      (left, right) =>
        left.renderer.getNextScheduleTime() -
        right.renderer.getNextScheduleTime(),
    );

    for (const entry of prioritizedEntries) {
      if (currentStartTime !== entry.lastStartTime) {
        entry.renderer.reset(ctx.currentTime);
        entry.lastStartTime = currentStartTime;
      }

      try {
        await entry.renderer.process(
          ctx,
          master,
          entry.trackClips,
          entry.getInput,
          {
            baseContextTime: ctx.currentTime,
            baseTicks: audioSystem.getCurrentPlaybackTicks(),
          },
          { lookahead: SHARED_LOOKAHEAD_SECONDS },
        );
      } catch (error) {
        console.warn("[Audio] Track scheduling failed", error);
      }
    }
  }

  if (!sharedSchedulerActive) return;

  sharedSchedulerTimeout = setTimeout(() => {
    void runSharedSchedulerTick();
  }, SHARED_SCHEDULER_INTERVAL_MS);
}

function ensureSharedSchedulerLoop() {
  if (sharedSchedulerActive) return;
  sharedSchedulerActive = true;
  clearSharedSchedulerTimeout();
  void runSharedSchedulerTick();
}

export function useAudioTrack(
  trackId: string,
  adjustmentEffectResolver?: AdjustmentEffectResolver | null,
) {
  const entriesRef = useRef<Map<string, SharedAudioTrackEntry>>(new Map());
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const trackClips = useTimelineClipsForTrack(trackId, false);
  const getInput = useAssetStore((state) => state.getInput);
  const assets = useAssetStore((state) => state.assets);
  const getInputRef = useRef(getInput);

  useEffect(() => {
    getInputRef.current = getInput;
    for (const entry of entriesRef.current.values()) {
      entry.getInput = getInput;
    }
  }, [getInput]);

  useEffect(() => {
    const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));
    const lanes = resolveRenderableAudioClipLanes(
      trackClips,
      assetsById,
    ).map((lane) => sortTrackClipsByStart(lane));

    const nextKeys = new Set<string>();
    lanes.forEach((lane, index) => {
      const key = `${trackId}::audio-lane-${index}`;
      nextKeys.add(key);
      const existing = entriesRef.current.get(key);
      if (existing) {
        existing.trackClips = lane;
        existing.getInput = getInputRef.current;
        return;
      }

      const renderer = new TrackAudioRenderer(trackId, adjustmentEffectResolver);
      const entry: SharedAudioTrackEntry = {
        renderer,
        trackClips: lane,
        getInput: getInputRef.current,
        lastStartTime: audioSystem.getStartTime(),
      };
      entriesRef.current.set(key, entry);
      sharedTrackEntries.set(key, entry);

      const ctx = audioSystem.getContext();
      if (ctx && usePlayerStore.getState().isPlaying) {
        renderer.reset(ctx.currentTime);
      }
    });

    for (const [key, entry] of entriesRef.current.entries()) {
      if (nextKeys.has(key)) continue;
      sharedTrackEntries.delete(key);
      entry.renderer.dispose();
      entriesRef.current.delete(key);
    }

    if (usePlayerStore.getState().isPlaying && lanes.length > 0) {
      ensureSharedSchedulerLoop();
    } else {
      maybeStopSharedSchedulerLoop();
    }
  }, [adjustmentEffectResolver, assets, trackClips, trackId]);

  useEffect(() => {
    const entries = entriesRef.current;
    return () => {
      for (const [key, entry] of entries.entries()) {
        sharedTrackEntries.delete(key);
        entry.renderer.dispose();
      }
      entries.clear();
      maybeStopSharedSchedulerLoop();
    };
  }, []);

  useEffect(() => {
    if (isPlaying) {
      void audioSystem.resume();
      const ctx = audioSystem.getContext();
      if (ctx) {
        for (const entry of entriesRef.current.values()) {
          entry.renderer.reset(ctx.currentTime);
          entry.lastStartTime = audioSystem.getStartTime();
        }
      }
      ensureSharedSchedulerLoop();
      return;
    }

    for (const entry of entriesRef.current.values()) {
      entry.renderer.stop();
    }
    maybeStopSharedSchedulerLoop();
  }, [isPlaying]);
}
