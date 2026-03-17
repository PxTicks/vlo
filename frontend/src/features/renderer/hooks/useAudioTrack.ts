import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { Input } from "mediabunny";
import { useTimelineClipsForTrack } from "../../timeline";
import { useAssetStore } from "../../userAssets";
import { usePlayerStore } from "../../player/usePlayerStore";
import { audioSystem } from "../../player/services/AudioSystem";
import { TrackAudioRenderer } from "../services/TrackAudioRenderer";
import { sortTrackClipsByStart } from "../utils/clipLookup";
import type { TimelineClip } from "../../../types/TimelineTypes";

const SHARED_LOOKAHEAD_SECONDS = 2.0;
const SHARED_SCHEDULER_INTERVAL_MS = 50;

interface SharedAudioTrackEntry {
  rendererRef: MutableRefObject<TrackAudioRenderer | null>;
  trackClipsRef: MutableRefObject<TimelineClip[]>;
  getInputRef: MutableRefObject<(assetId: string) => Promise<Input | null>>;
  lastStartTimeRef: MutableRefObject<number>;
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
  if (sharedTrackEntries.size > 0 && usePlayerStore.getState().isPlaying)
    return;
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
      (left, right) => {
        const leftTime =
          left.rendererRef.current?.getNextScheduleTime() ??
          Number.POSITIVE_INFINITY;
        const rightTime =
          right.rendererRef.current?.getNextScheduleTime() ??
          Number.POSITIVE_INFINITY;
        return leftTime - rightTime;
      },
    );

    for (const entry of prioritizedEntries) {
      const renderer = entry.rendererRef.current;
      if (!renderer) continue;

      if (currentStartTime !== entry.lastStartTimeRef.current) {
        renderer.reset(ctx.currentTime);
        entry.lastStartTimeRef.current = currentStartTime;
      }

      try {
        await renderer.process(
          ctx,
          master,
          entry.trackClipsRef.current,
          entry.getInputRef.current,
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

export function useAudioTrack(trackId: string) {
  // --- Refs ---
  const rendererRef = useRef<TrackAudioRenderer | null>(null);
  const lastStartTimeRef = useRef<number>(0);

  // --- Store Selectors ---
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const trackClips = useTimelineClipsForTrack(trackId, false);
  const getInput = useAssetStore((state) => state.getInput);
  const trackClipsRef = useRef<TimelineClip[]>(trackClips);
  const getInputRef = useRef(getInput);

  useEffect(() => {
    trackClipsRef.current = sortTrackClipsByStart(trackClips);
  }, [trackClips]);

  useEffect(() => {
    getInputRef.current = getInput;
  }, [getInput]);

  // --- Initialize Renderer ---
  useEffect(() => {
    rendererRef.current = new TrackAudioRenderer(trackId);

    sharedTrackEntries.set(trackId, {
      rendererRef,
      trackClipsRef,
      getInputRef,
      lastStartTimeRef,
    });

    if (usePlayerStore.getState().isPlaying) {
      ensureSharedSchedulerLoop();
    }

    return () => {
      sharedTrackEntries.delete(trackId);
      rendererRef.current?.dispose();
      rendererRef.current = null;
      maybeStopSharedSchedulerLoop();
    };
  }, [trackId]);

  // --- Handle Play/Pause ---
  useEffect(() => {
    if (isPlaying) {
      void audioSystem.resume();
      const ctx = audioSystem.getContext();
      if (ctx && rendererRef.current) {
        // Reset and Pre-buffer
        rendererRef.current.reset(ctx.currentTime);
        lastStartTimeRef.current = audioSystem.getStartTime();
      }
      ensureSharedSchedulerLoop();
    } else {
      rendererRef.current?.stop();
      maybeStopSharedSchedulerLoop();
    }
  }, [isPlaying]);
}
