import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Application, Container, Sprite } from "pixi.js";
import { useTimelineClipsForTrack } from "../../timeline";
import { useAssetStore } from "../../userAssets";
import { useProjectStore } from "../../project/useProjectStore";
import {
  playbackClock,
  playbackFrameClock,
} from "../../player/services/PlaybackClock";
import { usePlayerStore } from "../../player/usePlayerStore";
import type {
  TimelineClip,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import { applyClipTransforms, livePreviewParamStore } from "../../transformations";
import { TrackRenderEngine } from "../services/TrackRenderEngine";
import {
  findActiveClipAtTicks,
  sortTrackClipsByStart,
} from "../utils/clipLookup";

/**
 * Build a Map<parentClipId, maskClip[]> from parent clips' mask components.
 */
function buildMaskClipIndex(
  allTrackClips: TimelineClip[],
): Map<string, MaskTimelineClip[]> {
  const index = new Map<string, MaskTimelineClip[]>();
  const clipById = new Map(allTrackClips.map((c) => [c.id, c] as const));

  for (const clip of allTrackClips) {
    if (clip.type === "mask") continue;
    const maskChildIds = (clip.clipComponents ?? [])
      .filter((component) => component.componentType === "mask")
      .map((component) => component.clipId);
    if (maskChildIds.length === 0) continue;

    const masks: MaskTimelineClip[] = [];
    for (const maskChildId of maskChildIds) {
      const child = clipById.get(maskChildId);
      if (child && child.type === "mask") {
        masks.push(child as MaskTimelineClip);
      }
    }
    if (masks.length > 0) {
      index.set(clip.id, masks);
    }
  }
  return index;
}

export interface TrackRenderEngineResult {
  spriteInstance: Sprite | null;
  activeClipRef: React.MutableRefObject<TimelineClip | null>;
  currentClipId: string | null;
}

/**
 * Renderer-owned hook that manages the TrackRenderEngine lifecycle,
 * clock-driven render loop, and active clip tracking for a single track.
 *
 * This hook contains NO interaction logic (no gizmos, no pointer handlers).
 * The player feature composes this with interaction hooks via useTrackRenderer.
 */
export function useTrackRenderEngine(
  trackId: string,
  app: Application | null,
  container: Container,
  zIndex: number,
  logicalDimensions: { width: number; height: number },
  registerSynchronizedPlaybackRenderer?: (
    trackId: string,
    renderer: ((time: number) => Promise<void>) | null,
  ) => void,
): TrackRenderEngineResult {
  const engineRef = useRef<TrackRenderEngine | null>(null);
  const [spriteInstance, setSpriteInstance] = useState<Sprite | null>(null);

  // Store active clip ref for callbacks
  const activeClipRef = useRef<TimelineClip | null>(null);

  // Memoize `logicalDimensions` in ref, but trigger effects on change
  const logicalDimensionsRef = useRef(logicalDimensions);

  // OPTIMIZATION: Filter clips for this track.
  // Separate non-mask clips (for track rendering) from mask clips (for mask controller).
  const allTrackClips = useTimelineClipsForTrack(trackId);

  const sortedTrackClips = useMemo(
    () => sortTrackClipsByStart(allTrackClips.filter((c) => c.type !== "mask")),
    [allTrackClips],
  );

  const maskClipsByParent = useMemo(
    () => buildMaskClipIndex(allTrackClips),
    [allTrackClips],
  );
  const assets = useAssetStore((state) => state.assets);
  const assetsById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset] as const)),
    [assets],
  );
  const fps = useProjectStore((state) => state.config.fps);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const [currentClipId, setCurrentClipId] = useState<string | null>(null);
  const currentClipIdRef = useRef<string | null>(null);
  const livePlaybackStateRef = useRef({
    assets,
    fps,
    maskClipsByParent,
    sortedTrackClips,
  });

  livePlaybackStateRef.current = {
    assets,
    fps,
    maskClipsByParent,
    sortedTrackClips,
  };

  const syncActiveClipState = useCallback((
    currentTime: number,
    trackClips: TimelineClip[],
  ) => {
    const activeClip = findActiveClipAtTicks(trackClips, currentTime);
    activeClipRef.current = activeClip || null;

    if (activeClip && activeClip.id !== currentClipIdRef.current) {
      currentClipIdRef.current = activeClip.id;
      setCurrentClipId(activeClip.id);
    } else if (!activeClip && currentClipIdRef.current !== null) {
      currentClipIdRef.current = null;
      setCurrentClipId(null);
    }

    return activeClip;
  }, []);

  useEffect(() => {
    logicalDimensionsRef.current = logicalDimensions;
    // Force immediate re-layout if logical dimensions change
    if (engineRef.current && activeClipRef.current) {
      const currentRenderTime = isPlaying
        ? playbackFrameClock.time
        : playbackClock.time;
      const activeMaskClips =
        maskClipsByParent.get(activeClipRef.current.id) ?? [];
      engineRef.current.forceUpdateTransforms(
        activeClipRef.current,
        logicalDimensions,
        currentRenderTime,
        activeMaskClips,
        assetsById,
      );
    }
  }, [
    assetsById,
    isPlaying,
    logicalDimensions,
    maskClipsByParent,
    spriteInstance,
  ]);

  const renderSynchronizedPlaybackFrame = useCallback(async (currentTime: number) => {
    const engine = engineRef.current;
    if (!engine) return;

    const currentState = livePlaybackStateRef.current;
    syncActiveClipState(currentTime, currentState.sortedTrackClips);

    await engine.renderSynchronizedPlaybackFrame(
      currentTime,
      currentState.sortedTrackClips,
      currentState.maskClipsByParent,
      currentState.assets,
      logicalDimensionsRef.current,
      { fps: currentState.fps },
    );
  }, [syncActiveClipState]);

  useEffect(() => {
    if (
      !registerSynchronizedPlaybackRenderer ||
      !engineRef.current ||
      isPlaying
    ) {
      return;
    }

    // Keep paused synchronized playback responsive to transform edits and
    // other clip-state changes without requiring a playhead move.
    if (!activeClipRef.current && currentClipIdRef.current === null) {
      return;
    }

    void renderSynchronizedPlaybackFrame(playbackClock.time);
  }, [
    assets,
    fps,
    isPlaying,
    logicalDimensions,
    maskClipsByParent,
    registerSynchronizedPlaybackRenderer,
    renderSynchronizedPlaybackFrame,
    sortedTrackClips,
    spriteInstance,
  ]);

  useEffect(() => {
    if (!engineRef.current || isPlaying) {
      return;
    }

    return livePreviewParamStore.subscribe(() => {
      const engine = engineRef.current;
      if (!engine) {
        return;
      }

      if (registerSynchronizedPlaybackRenderer) {
        if (!activeClipRef.current && currentClipIdRef.current === null) {
          return;
        }

        void renderSynchronizedPlaybackFrame(playbackClock.time);
        return;
      }

      engine.update(
        playbackClock.time,
        sortedTrackClips,
        maskClipsByParent,
        assets,
        logicalDimensionsRef.current,
        { fps },
      );
      syncActiveClipState(playbackClock.time, sortedTrackClips);
    });
  }, [
    assets,
    fps,
    isPlaying,
    maskClipsByParent,
    registerSynchronizedPlaybackRenderer,
    renderSynchronizedPlaybackFrame,
    sortedTrackClips,
    syncActiveClipState,
  ]);

  useEffect(() => {
    const engine = engineRef.current;
    const eventTarget = container as Container & {
      on?: (event: string, fn: () => void) => unknown;
      off?: (event: string, fn: () => void) => unknown;
    };

    if (
      !engine ||
      isPlaying ||
      typeof eventTarget.on !== "function" ||
      typeof eventTarget.off !== "function"
    ) {
      return;
    }

    let rafId: number | null = null;

    const refreshPausedViewportTransform = () => {
      if (rafId !== null) {
        return;
      }

      rafId = requestAnimationFrame(() => {
        rafId = null;

        const activeClip = syncActiveClipState(playbackClock.time, sortedTrackClips);
        if (!activeClip || !engineRef.current) {
          return;
        }

        const activeMaskClips = maskClipsByParent.get(activeClip.id) ?? [];
        engineRef.current.forceUpdateTransforms(
          activeClip,
          logicalDimensionsRef.current,
          playbackClock.time,
          activeMaskClips,
          assetsById,
        );
      });
    };

    eventTarget.on("zoomed", refreshPausedViewportTransform);
    eventTarget.on("moved", refreshPausedViewportTransform);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      eventTarget.off?.("zoomed", refreshPausedViewportTransform);
      eventTarget.off?.("moved", refreshPausedViewportTransform);
    };
  }, [
    assetsById,
    container,
    isPlaying,
    maskClipsByParent,
    sortedTrackClips,
    spriteInstance,
    syncActiveClipState,
  ]);

  // 1. Engine Lifecycle
  useEffect(() => {
    if (!trackId || !app) return;

    // Initialize Engine
    const engine = new TrackRenderEngine(
      zIndex,
      (clipId, transformTime) => {
        // Callback when frame is ready (Live Mode)
        if (activeClipRef.current && activeClipRef.current.id === clipId) {
          applyClipTransforms(
            engine.sprite,
            activeClipRef.current,
            logicalDimensionsRef.current,
            transformTime,
          );
          engine.syncMaskSpriteTransform();
        }
      },
      app.renderer,
    );

    engine.addTo(container);
    engineRef.current = engine;
    setSpriteInstance(engine.sprite);

    // Ensure sorting
    // eslint-disable-next-line react-hooks/immutability
    container.sortableChildren = true;
    container.sortChildren();

    return () => {
      engine.dispose();
      if (container && !container.destroyed && !engine.container.destroyed) {
        container.removeChild(engine.container);
      }
      engineRef.current = null;
      setSpriteInstance(null);
    };
  }, [trackId, app, zIndex, container]);

  useEffect(() => {
    if (!registerSynchronizedPlaybackRenderer) return;

    registerSynchronizedPlaybackRenderer(trackId, renderSynchronizedPlaybackFrame);

    return () => {
      registerSynchronizedPlaybackRenderer(trackId, null);
    };
  }, [
    registerSynchronizedPlaybackRenderer,
    renderSynchronizedPlaybackFrame,
    trackId,
  ]);

  // 2. Z-Index Updates
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setZIndex(zIndex);
      if (container && !container.destroyed) {
        container.sortChildren();
      }
    }
  }, [zIndex, container]);

  // 3. Render Loop
  useEffect(() => {
    if (
      !engineRef.current ||
      !trackId ||
      isPlaying ||
      registerSynchronizedPlaybackRenderer
    ) {
      return;
    }

    const render = (currentTime: number) => {
      if (!engineRef.current) return;

      // Delegate update to engine
      engineRef.current.update(
        currentTime,
        sortedTrackClips,
        maskClipsByParent,
        assets,
        logicalDimensionsRef.current,
        { fps },
      );
      syncActiveClipState(currentTime, sortedTrackClips);
    };

    // Initial render
    render(playbackClock.time);

    const unsubscribe = playbackClock.subscribe((time) => {
      render(time);
    });

    return unsubscribe;
  }, [
    assets,
    fps,
    isPlaying,
    maskClipsByParent,
    registerSynchronizedPlaybackRenderer,
    sortedTrackClips,
    syncActiveClipState,
    trackId,
  ]);

  return { spriteInstance, activeClipRef, currentClipId };
}
