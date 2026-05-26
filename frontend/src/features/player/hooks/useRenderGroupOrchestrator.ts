import { useEffect, useMemo, useRef } from "react";
import type { Container } from "pixi.js";
import { RenderGroupOrchestrator } from "../../renderer/services/RenderGroupOrchestrator";
import { playbackClock } from "../services/PlaybackClock";

/**
 * Owns a single `RenderGroupOrchestrator` tied to the Player's viewport
 * container. In v2 the orchestrator's group set is always empty — the
 * adjustment-clip derivation (phase 3) will push computed groups in via the
 * orchestrator's per-tick `sync(...)`.
 *
 * For now, an imperative `sync(playbackClock.time, visualTrackIds)` still runs
 * whenever `visualTrackIds` changes so registered engine containers settle
 * under the (always empty) root on paused edits.
 *
 * Returns:
 *   - `orchestrator`: instance to thread through `<TrackLayer />`.
 *   - `syncRef`: stable ref to the per-tick sync function the Player's
 *     synchronized-playback loop invokes between awaited frame renderers and
 *     `pixiApp.render()`.
 */
export function useRenderGroupOrchestrator(
  viewport: Container | null,
  logicalDimensions: { width: number; height: number },
  visualTrackIds: readonly string[],
): {
  orchestrator: RenderGroupOrchestrator | null;
  syncRef: React.RefObject<(currentTick: number) => void>;
} {
  const orchestrator = useMemo(() => {
    if (!viewport) return null;
    return new RenderGroupOrchestrator(viewport, { logicalDimensions });
    // logicalDimensions intentionally omitted; pushed via setLogicalDimensions
    // below so the orchestrator (and its registered tracks) survives resizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport]);

  useEffect(() => {
    orchestrator?.setLogicalDimensions(logicalDimensions);
  }, [orchestrator, logicalDimensions]);

  useEffect(() => {
    if (!orchestrator) return;
    return () => orchestrator.dispose();
  }, [orchestrator]);

  // Imperative sync whenever the visual-track order changes (paused edits to
  // structure should reflect without waiting for the next clock tick).
  useEffect(() => {
    if (!orchestrator) return;
    orchestrator.sync(playbackClock.time, visualTrackIds);
  }, [orchestrator, visualTrackIds]);

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

  return { orchestrator, syncRef };
}
