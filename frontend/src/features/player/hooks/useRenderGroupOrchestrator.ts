import { useEffect, useMemo, useRef } from "react";
import type { Container } from "pixi.js";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { useProjectStore } from "../../project/useProjectStore";
import { RenderGroupOrchestrator } from "../../renderer/services/RenderGroupOrchestrator";
import { AdjustmentEffectResolver } from "../../renderer/services/AdjustmentEffectResolver";
import { playbackClock } from "../../../core/playback/PlaybackClock";

/**
 * Owns a single `RenderGroupOrchestrator` tied to the Player's viewport
 * container. Pushes the timeline's tracks + clips into the orchestrator
 * (the source of truth for adjustment-clip-derived groups), and triggers
 * an imperative sync whenever the source or `visualTrackIds` change so
 * paused edits reflect without waiting for the next clock tick.
 *
 * Returns:
 *   - `orchestrator`: instance to thread through `<TrackLayer />`.
 *   - `syncRef`: stable ref to the per-tick sync function the Player's
 *     synchronized-playback loop invokes between awaited frame renderers
 *     and `pixiApp.render()`.
 */
export function useRenderGroupOrchestrator(
  viewport: Container | null,
  logicalDimensions: { width: number; height: number },
  visualTrackIds: readonly string[],
  deferSyncToFramePlan = false,
): {
  orchestrator: RenderGroupOrchestrator | null;
  adjustmentEffectResolver: AdjustmentEffectResolver | null;
  syncRef: React.RefObject<(currentTick: number) => void>;
} {
  const adjustmentEffectResolver = useMemo(
    () => new AdjustmentEffectResolver(),
    [],
  );
  const orchestrator = useMemo(() => {
    if (!viewport) return null;
    return new RenderGroupOrchestrator(viewport, {
      logicalDimensions,
      adjustmentEffectResolver,
    });
    // logicalDimensions intentionally omitted; pushed via setLogicalDimensions
    // below so the orchestrator (and its registered tracks) survives resizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustmentEffectResolver, viewport]);

  useEffect(() => {
    orchestrator?.setLogicalDimensions(logicalDimensions);
  }, [orchestrator, logicalDimensions]);

  useEffect(() => {
    if (!orchestrator) return;
    return () => orchestrator.dispose();
  }, [orchestrator]);

  // Subscribe to the canonical source-of-truth for adjustment-clip
  // derivation. Tolerate undefined from test mocks that don't include the
  // store fields — defaults to empty arrays.
  const tracks = useTimelineStore((s) => s.tracks ?? []);
  const clips = useTimelineStore((s) => s.clips ?? []);
  const projectFps = useProjectStore((s) => s.config.fps);
  useEffect(() => {
    adjustmentEffectResolver.setAdjustmentSource(tracks, clips, projectFps);
    orchestrator?.setAdjustmentSource(tracks, clips, projectFps);
  }, [adjustmentEffectResolver, orchestrator, tracks, clips, projectFps]);

  // Imperative sync whenever the source or visual-track order changes,
  // so paused edits to either reflect without waiting for the next tick.
  useEffect(() => {
    if (!orchestrator || deferSyncToFramePlan) return;
    orchestrator.sync(playbackClock.time, visualTrackIds);
  }, [
    orchestrator,
    tracks,
    clips,
    visualTrackIds,
    deferSyncToFramePlan,
  ]);

  const visualTrackIdsRef = useRef<readonly string[]>(visualTrackIds);
  useEffect(() => {
    visualTrackIdsRef.current = visualTrackIds;
  }, [visualTrackIds]);

  const syncRef = useRef<(currentTick: number) => void>(() => {});
  useEffect(() => {
    syncRef.current = (currentTick: number) => {
      orchestrator?.sync(currentTick, visualTrackIdsRef.current ?? []);
    };
  }, [orchestrator]);

  return { orchestrator, adjustmentEffectResolver, syncRef };
}
