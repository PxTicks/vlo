import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Application, Container, Sprite } from "pixi.js";
import { useTimelineClipsForTrack } from "../../timeline";
import { useAssetStore } from "../../userAssets";
import { useProjectStore } from "../../project/useProjectStore";
import { livePreviewTextStore } from "../../text/services/livePreviewTextStore";
import {
  playbackClock,
  playbackFrameClock,
} from "../../../core/playback/PlaybackClock";
import { usePlayerStore } from "../../player/usePlayerStore";
import type {
  TimelineClip,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import { applyClipTransforms } from "../../transformations";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";
import { useMaskViewStore } from "../../masks/store/useMaskViewStore";
import { getMaskCompositionComponent } from "../../masks/model/maskBooleanExpression";
import type { AdjustmentEffectResolver } from "../services/AdjustmentEffectResolver";
import { RenderGroupOrchestrator } from "../services/RenderGroupOrchestrator";
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
    const maskChildIds = (clip.components ?? [])
      .filter((component) => component.type === "mask_ref")
      .map((component) => component.parameters.maskClipId);
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

/**
 * Stable string capturing which masks are present and their
 * render-affecting identity (mode + backing source), but not their layout
 * transforms. Used to detect when a paused frame must re-composite masks.
 */
function buildMaskSetSignature(
  maskClipsByParent: Map<string, MaskTimelineClip[]>,
): string {
  const parts: string[] = [];
  for (const [parentId, maskClips] of maskClipsByParent) {
    for (const mask of maskClips) {
      parts.push(
        [
          parentId,
          mask.id,
          mask.maskMode,
          mask.maskType,
          mask.maskInverted ? "1" : "0",
          mask.sam2MaskAssetId ?? "",
          mask.generationMaskAssetId ?? "",
          mask.brushMaskAssetId ?? "",
        ].join(":"),
      );
    }
  }
  return parts.join("|");
}

export interface TrackRenderEngineResult {
  spriteInstance: Sprite | null;
  activeClipRef: React.MutableRefObject<TimelineClip | null>;
  currentClipId: string | null;
  syncMaskSpriteTransform: () => void;
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
  /**
   * When provided, the orchestrator owns Pixi parenting (register on mount,
   * unregister on cleanup) so group containers can interpose between
   * `container` and the engine. When omitted, falls back to the legacy
   * `engine.addTo(container)` direct attachment used by existing tests.
   */
  orchestrator?: RenderGroupOrchestrator | null,
  adjustmentEffectResolver?: AdjustmentEffectResolver | null,
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
  const assets = useAssetStore((state) => state.assets);
  const assetsById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset] as const)),
    [assets],
  );

  const renderableTrackClips = allTrackClips;

  const sortedTrackClips = useMemo(
    () =>
      sortTrackClipsByStart(
        renderableTrackClips.filter((c) => c.type !== "mask"),
      ),
    [renderableTrackClips],
  );

  const maskClipsByParent = useMemo(
    () => buildMaskClipIndex(renderableTrackClips),
    [renderableTrackClips],
  );

  // Signature of the mask *set* (membership, mode, and asset/source identity)
  // — deliberately excludes layout transforms, which already preview live. It
  // changes when a mask is added/removed, a mask's mode is toggled, or a
  // SAM2/generation/brush mask result lands, which is exactly when a paused
  // frame needs to re-composite to show the change immediately.
  const maskSetSignature = useMemo(
    () => buildMaskSetSignature(maskClipsByParent),
    [maskClipsByParent],
  );
  // Parent-clip mask orchestration (equation expression, on/off, inverse
  // algebra, composite edge transforms) lives on the `mask_composition`
  // component — not in `maskSetSignature` — so changes to it must drive the
  // paused re-composite too. Otherwise toggling the equation or inversion only
  // takes effect on the next scrub.
  const maskCompositionSignature = useMemo(
    () =>
      sortedTrackClips
        .map((clip) => {
          if (clip.type === "mask") {
            return "";
          }
          const composition = getMaskCompositionComponent(clip);
          return composition
            ? `${clip.id}:${JSON.stringify(composition.parameters)}`
            : "";
        })
        .filter(Boolean)
        .join("|"),
    [sortedTrackClips],
  );
  // Transient single-mask preview: changes here must recomposite the paused
  // frame, but only via the mask-only refresh path below (never the heavier
  // content re-render, which would needlessly re-request the decoder).
  const maskPreviewTarget = useMaskViewStore((state) => state.maskPreviewTarget);
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

  /**
   * Per-clip presentation lookup: returns the active clip at `presentationTick`
   * on this track (or null) plus the rebased effective tick. Equivalent to
   * the engine's `resolveActiveClipAtPresentation` but at the hook level —
   * the hook only needs the active clip for state syncing.
   */
  const findActiveClip = useCallback(
    (
      trackClips: TimelineClip[],
      presentationTick: number,
    ): TimelineClip | undefined => {
      if (adjustmentEffectResolver) {
        return (
          adjustmentEffectResolver
            .getPresentationLookup()
            .findActiveClipAt(trackId, presentationTick)?.clip ?? undefined
        );
      }
      return findActiveClipAtTicks(trackClips, presentationTick);
    },
    [adjustmentEffectResolver, trackId],
  );

  useEffect(() => {
    // Keep the rAF playback loop reading the latest snapshot of playback
    // inputs without taking them as callback dependencies.
    livePlaybackStateRef.current = {
      assets,
      fps,
      maskClipsByParent,
      sortedTrackClips,
    };
  });

  const syncActiveClipState = useCallback((
    currentTime: number,
    trackClips: TimelineClip[],
  ) => {
    const activeClip = findActiveClip(trackClips, currentTime);
    activeClipRef.current = activeClip || null;

    if (activeClip && activeClip.id !== currentClipIdRef.current) {
      currentClipIdRef.current = activeClip.id;
      setCurrentClipId(activeClip.id);
    } else if (!activeClip && currentClipIdRef.current !== null) {
      currentClipIdRef.current = null;
      setCurrentClipId(null);
    }

    return activeClip;
  }, [findActiveClip]);

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

  const syncMaskSpriteTransform = useCallback(() => {
    engineRef.current?.syncMaskSpriteTransform();
  }, []);

  useEffect(() => {
    if (
      !registerSynchronizedPlaybackRenderer ||
      !engineRef.current ||
      isPlaying
    ) {
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

    const rerenderPausedFrame = () => {
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
    };

    const unsubscribeLiveParams = livePreviewParamStore.subscribe(
      rerenderPausedFrame,
    );
    const unsubscribeLiveText = livePreviewTextStore.subscribe(
      rerenderPausedFrame,
    );

    return () => {
      unsubscribeLiveParams();
      unsubscribeLiveText();
    };
  }, [
    assets,
    fps,
    isPlaying,
    maskClipsByParent,
    registerSynchronizedPlaybackRenderer,
    renderSynchronizedPlaybackFrame,
    sortedTrackClips,
    spriteInstance,
    syncActiveClipState,
  ]);

  // Make mask-set changes (add/remove, mode toggle, SAM2/generation/brush
  // result landing) visible on a paused frame without waiting for a playhead move.
  // Deferred to the next frame so the engine has committed the new mask scene
  // nodes before we re-composite; the paused ticker then flushes the result.
  useEffect(() => {
    if (isPlaying || !engineRef.current || !spriteInstance) {
      return;
    }

    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      const engine = engineRef.current;
      if (!engine) return;

      const state = livePlaybackStateRef.current;
      void engine.refreshMasksAtPausedFrame(
        playbackClock.time,
        state.sortedTrackClips,
        state.maskClipsByParent,
        state.assets,
        logicalDimensionsRef.current,
        { fps: state.fps },
      );
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [
    isPlaying,
    maskSetSignature,
    maskCompositionSignature,
    maskPreviewTarget,
    spriteInstance,
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
  // The engine integrates with Pixi.js, which is intentionally imperative —
  // attaching the engine and enabling sortableChildren on the parent
  // container both require mutating Pixi-owned objects across the effect
  // boundary. Cleanup restores the container by removing the engine's
  // children, so the mutations are scoped to this effect's lifetime.
  // eslint-disable-next-line react-hooks/immutability
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
      { trackId, adjustmentEffectResolver },
    );

    if (orchestrator) {
      orchestrator.registerTrack(trackId, engine.container);
    } else {
      engine.addTo(container);
      // Ensure sorting on the Pixi container (justified above on the useEffect).
      // eslint-disable-next-line react-hooks/immutability
      container.sortableChildren = true;
      container.sortChildren();
    }
    engineRef.current = engine;
    setSpriteInstance(engine.sprite);

    return () => {
      engine.dispose();
      if (orchestrator) {
        orchestrator.unregisterTrack(trackId, engine.container);
      } else if (
        container &&
        !container.destroyed &&
        !engine.container.destroyed
      ) {
        container.removeChild(engine.container);
      }
      engineRef.current = null;
      setSpriteInstance(null);
    };
    // zIndex is read only for the engine's initial value; effect #2 below
    // applies zIndex changes in place so reorders don't tear down the engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, app, container, orchestrator, adjustmentEffectResolver]);

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

  return {
    spriteInstance,
    activeClipRef,
    currentClipId,
    syncMaskSpriteTransform,
  };
}
