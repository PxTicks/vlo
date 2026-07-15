import type { Container } from "pixi.js";
import type { ClipTransform } from "../../types/TimelineTypes";
import { useDebugStore } from "../../shared/debug/useDebugStore";
import { applyTransformStack, runApplicators } from "./applyTransformations";
import { releaseTransformationFilters } from "./catalogue/filterRuntime";

/**
 * Minimal shape `applyGroupTransforms` consumes from its `group` argument.
 * Satisfied by both the legacy `TimelineGroup` (kept around as internal
 * scaffolding) and the new `DerivedRenderGroup` (computed per-tick from
 * adjustment clips). Picked deliberately so the orchestrator can hand
 * either through without an adapter.
 */
export interface AppliableGroup {
  transformations: ClipTransform[];
  /** Clip-local origin tick — keyframe sampling is anchored here so
   *  moving the group on the timeline moves its keyframes with it. */
  start: number;
  /** Visible window length, forwarded to handlers that care about output-
   *  domain math (visual-duration ratios, etc.). */
  timelineDuration: number;
  /** Optional per-frame sample tick in the group's own input-level domain. */
  sampleTick?: number;
}

/**
 * Apply a render group's transformations to its Pixi container. This is the
 * single seam through which group-level effects engage.
 *
 * The container has no texture; the filter applicator needs an explicit
 * content size for spatial-parameter scaling (worldX/worldY/worldUniform,
 * point-bound filters). We pass `logicalDimensions` for both `container` and
 * `content` in the stack context — group containers are textureless covers
 * over the project's logical viewport.
 *
 * Time domain: keyframes on a group are clip-local. Usually `stackTime =
 * currentTick - group.start`; per-clip adjustment retimes can provide
 * `sampleTick` so visual keyframes follow the same rebased timing as the
 * underlying clip content.
 *
 * The orchestrator hands a `DerivedRenderGroup` here, computed per tick
 * from the adjustment clips on the timeline. The `AppliableGroup`
 * structural type below is the minimal contract this function consumes —
 * the legacy `TimelineGroup` shape also satisfies it for tests.
 */
export function applyGroupTransforms(
  container: Container,
  group: AppliableGroup,
  logicalDimensions: { width: number; height: number },
  currentTick: number,
): void {
  // Reset to identity before dispatch so toggling a transform off — or a
  // group's `transformations` array shrinking — reverts cleanly without
  // leaving residual state from a prior frame.
  container.position.set(0, 0);
  container.scale.set(1, 1);
  container.rotation = 0;
  // Debug-mode visible cue (separate from any transform-driven alpha): this
  // function only runs for groups active at `currentTick` (the orchestrator
  // detaches inactive group containers), so flipping alpha here makes "the
  // group is engaging" obvious in the player. Toggled from the project-
  // settings menu's Debug section in dev builds.
  container.alpha = useDebugStore.getState().debugMode ? 0.5 : 1;

  // Identity is in place; no work to do.
  if (!group.transformations || group.transformations.length === 0) {
    releaseTransformationFilters(container);
    return;
  }

  const stackTime = (group.sampleTick ?? currentTick) - group.start;
  const { state } = applyTransformStack(
    group.transformations,
    {
      container: logicalDimensions,
      content: logicalDimensions,
      visualTime: stackTime,
      visualDuration: group.timelineDuration,
    },
    stackTime,
    {
      baseLayoutMode: "origin",
      // No live-param subscribers for group transforms yet; skip the
      // notify pass to avoid touching the per-clip store.
      notifyLiveParams: false,
    },
  );
  runApplicators(container, state, logicalDimensions);
}
