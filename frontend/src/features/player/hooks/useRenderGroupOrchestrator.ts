import { useEffect, useMemo, useRef } from "react";
import type { Container } from "pixi.js";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { RenderGroupOrchestrator } from "../../renderer/services/RenderGroupOrchestrator";
import { playbackClock } from "../services/PlaybackClock";

/**
 * Owns a single `RenderGroupOrchestrator` tied to the Player's viewport
 * container. Subscribes to the timeline store's `groups` and pushes them into
 * the orchestrator on change.
 *
 * After any state change that would alter parenting (groups list, group
 * visibility/window, or visual-track order), an imperative `sync` runs
 * immediately against the current `playbackClock.time` so paused edits reflect
 * in the Pixi scene graph without waiting for the next clock tick.
 *
 * Returns:
 *   - `orchestrator`: instance to thread through `<TrackLayer />`.
 *   - `syncRef`: stable ref to the per-tick sync function the Player's
 *     synchronized-playback loop invokes between awaited frame renderers and
 *     `pixiApp.render()`. Reads the latest `visualTrackIds` through an
 *     internal ref so the function identity doesn't churn on every order
 *     change.
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

  // Tolerate undefined from test mocks that pre-date the groups field; the
  // production store always provides an array.
  const groups = useTimelineStore((state) => state.groups ?? []);

  // Push the latest groups into the orchestrator. React runs effects in
  // declaration order on a commit, so this fires before the imperative-sync
  // effect below — guaranteeing the orchestrator sees `groups` before it
  // computes desired parenting.
  useEffect(() => {
    orchestrator?.setGroups(groups);
  }, [orchestrator, groups]);

  // Imperative sync on every meaningful state change. Covers paused edits
  // (group create/delete/visibility/range, visual-track add/remove/reorder)
  // that would otherwise wait for the next clock tick to reflect.
  useEffect(() => {
    if (!orchestrator) return;
    orchestrator.sync(playbackClock.time, visualTrackIds);
  }, [orchestrator, groups, visualTrackIds]);

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
