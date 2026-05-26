import type { Container } from "pixi.js";
import type { TimelineGroup } from "../../types/TimelineTypes";

/**
 * Apply a render group's transformations to its Pixi container. This is the
 * single seam through which group-level effects will engage.
 *
 * v1 scaffolding: no transforms are wired up yet. We reset to identity so the
 * group container is a pure pass-through whenever it's attached. The follow-up
 * pass will dispatch through a shared `applyTransformStack(...)` extracted from
 * `applyClipTransforms` using:
 *   - target = container (satisfies ClipTransformTarget unchanged)
 *   - contentSizeOverride = logicalDimensions (bypasses the no-texture early
 *     return in applyTransformations.ts)
 *   - baseLayoutMode = "origin" (avoids re-centering each frame)
 *   - time = currentTick (group keyframes live in absolute project ticks)
 * Speed and range-mask paths are clip-specific and will not apply here.
 *
 * Composite-clip interaction: composites are baked to a proxy by
 * resolveRenderableClip before any engine sees them, so a composite-on-a-track
 * -in-a-group is identical to a video-on-a-track-in-a-group from the
 * orchestrator's perspective.
 */
export function applyGroupTransforms(
  container: Container,
  group: TimelineGroup,
  logicalDimensions: { width: number; height: number },
  currentTick: number,
): void {
  container.position.set(0, 0);
  container.scale.set(1, 1);
  container.rotation = 0;
  container.filters = null;
  // Dev-only visible cue: this function only runs for groups that are active
  // at `currentTick` (the orchestrator detaches inactive group containers),
  // so flipping alpha here makes "the group is engaging" obvious in the
  // player without committing to a UX in production. Stripped from prod
  // bundles by Vite's import.meta.env.DEV dead-code elimination.
  container.alpha = import.meta.env.DEV ? 0.5 : 1;

  void group;
  void logicalDimensions;
  void currentTick;
}
