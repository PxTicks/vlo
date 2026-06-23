import { Container } from "pixi.js";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { applyGroupTransforms } from "../../transformations/applyGroupTransforms";
import { type DerivedRenderGroup } from "../utils/deriveAdjustmentGroups";
import { AdjustmentEffectResolver } from "./AdjustmentEffectResolver";
import type { ScenePresentationPlan } from "./framePlanning";

export interface RenderGroupOrchestratorOptions {
  /** Project resolution used by applyGroupTransforms. Defaults to 1920x1080
   *  until the caller wires the real logicalDimensions. */
  logicalDimensions?: { width: number; height: number };
  adjustmentEffectResolver?: AdjustmentEffectResolver;
}

interface ForestEntry {
  group: DerivedRenderGroup;
  /** The Pixi parent this group container should be attached to: either
   *  another active group's container (nested) or `root` (top-level). */
  desiredParent: Container;
  /** Visual-index of the top-most track this group wraps. Used for zIndex
   *  assignment within its immediate parent. */
  topMostVisualIndex: number;
}

/**
 * Owns Pixi-side parenting of track engine containers and adjustment-clip-
 * derived render group containers under a shared `root` container (typically
 * the ExportRenderer's `logicalStage` or the Player's viewport).
 *
 * Inputs:
 * - `registerTrack(trackId, engineContainer)`: track engines hand the
 *   orchestrator their container; the orchestrator decides its parent each
 *   tick based on the derived forest.
 * - `setAdjustmentSource(tracks, clips)`: the canonical source of truth for
 *   deriving render groups. Pushed by the Player whenever `tracks` or
 *   `clips` change (structural edits), and by the ExportRenderer once
 *   before its frame loop.
 *
 * Per tick (`sync(currentTick, visualTrackOrder)`):
 * - Run `deriveActiveAdjustmentGroups(tracks, clips, currentTick)` to get
 *   the nested forest of render groups for this tick.
 * - Diff against the cached group containers; create new ones lazily,
 *   destroy any whose `id` no longer appears in the forest (topology
 *   change), detach (but keep cached) containers that aren't active at
 *   this tick.
 * - Reparent group containers to match the forest's parent-of relation
 *   (nested groups parent under their outer container; top-level groups
 *   under `root`).
 * - Reparent each registered track engine container to its innermost
 *   wrapping group (or `root` if none).
 * - Assign zIndex using the codebase's `length - 1 - index` convention
 *   (engine containers from their visual-track index; group containers
 *   from their top-most member's visual-track index).
 * - Call `applyGroupTransforms` on each active group container.
 */
export class RenderGroupOrchestrator {
  private readonly root: Container;
  private readonly adjustmentEffectResolver: AdjustmentEffectResolver;
  private readonly tracks = new Map<string, Container>();
  private readonly groupContainers = new Map<string, Container>();
  private logicalDimensions: { width: number; height: number };
  private disposed = false;

  constructor(root: Container, options: RenderGroupOrchestratorOptions = {}) {
    this.root = root;
    this.adjustmentEffectResolver =
      options.adjustmentEffectResolver ?? new AdjustmentEffectResolver();
    this.logicalDimensions = options.logicalDimensions ?? {
      width: 1920,
      height: 1080,
    };
  }

  setLogicalDimensions(dimensions: { width: number; height: number }): void {
    this.logicalDimensions = dimensions;
  }

  /**
   * Seed the orchestrator with a track engine container. Idempotent for the
   * same (trackId, container) pair (StrictMode double-mount safe). If a
   * *different* container is registered for an existing trackId — for example
   * a fresh engine after a remount races ahead of the old engine's cleanup —
   * the previous container is detached from the tree first so the orchestrator
   * never silently leaks a stale subtree.
   */
  registerTrack(trackId: string, engineContainer: Container): void {
    if (this.disposed) return;
    const existing = this.tracks.get(trackId);
    if (existing === engineContainer) return;
    if (existing && !existing.destroyed && existing.parent) {
      existing.parent.removeChild(existing);
    }
    this.tracks.set(trackId, engineContainer);
    if (engineContainer.destroyed) return;
    if (engineContainer.parent !== this.root) {
      this.root.addChild(engineContainer);
    }
  }

  /**
   * Tolerates double-unregister and destroyed engine containers. When
   * `engineContainer` is provided, the unregister is a no-op unless that exact
   * container is the one currently mapped to `trackId` — protects against a
   * late cleanup of an already-replaced container yanking the new one out of
   * the tree.
   */
  unregisterTrack(trackId: string, engineContainer?: Container): void {
    const current = this.tracks.get(trackId);
    if (!current) return;
    if (engineContainer && engineContainer !== current) return;
    this.tracks.delete(trackId);
    if (current.destroyed) return;
    const parent = current.parent;
    if (parent && !parent.destroyed) {
      parent.removeChild(current);
    }
  }

  /**
   * Push the canonical source-of-truth for adjustment-clip-derived groups.
   * Called by the Player whenever `tracks` or `clips` change (structural
   * edits) and by the ExportRenderer once before its frame loop. The
   * derivation runs inside `sync(...)` against this cached source.
   *
   * Evicts cached group containers whose source adjustment clip has been
   * removed from the new `clips` list. Containers whose source clip is
   * still live but whose first-track-in-run changes (a `<clipId>@<trackId>`
   * id no longer in the forest) stay cached until the source clip itself
   * is removed — the cache stays permissive across reach edits.
   */
  setAdjustmentSource(
    tracks: readonly TimelineTrack[],
    clips: readonly TimelineClip[],
    fps: number,
  ): void {
    if (this.disposed) return;
    this.adjustmentEffectResolver.setAdjustmentSource(tracks, clips, fps);

    const liveAdjustmentClipIds = new Set<string>();
    for (const clip of clips) {
      if (clip.type === "adjustment") liveAdjustmentClipIds.add(clip.id);
    }
    for (const [containerId, container] of this.groupContainers) {
      const sourceClipId = containerId.split("@")[0];
      if (!liveAdjustmentClipIds.has(sourceClipId)) {
        this.destroyGroupContainer(container);
        this.groupContainers.delete(containerId);
      }
    }
  }

  /**
   * Rewrite parenting for the current tick. Diffs the derived forest
   * against the orchestrator's cache and applies the minimum reparenting.
   *
   * Order: per-clip transforms (run inside engine.update() / awaited
   * synchronized renderers) MUST complete before this call;
   * renderer.render(...) MUST be called after.
   *
   * Performance note: the forest is re-derived from scratch every tick,
   * but the Pixi scene graph is NOT rebuilt — `groupContainers` is cached
   * across ticks and reparenting is diff-only (`engineContainer.parent
   * !== desiredParent` short-circuits). The derivation itself is
   * O(adjustments × depth + visualTracks × stackDepth) and allocates a
   * few small JS objects per tick. For realistic project sizes this is
   * comfortably sub-millisecond. If profiling ever flags it, memoise by
   * (clipsRevision, tracksRevision, transition-window-index) — the forest
   * is constant between adjacent active-window boundary ticks, so a
   * window cache fed by `setAdjustmentSource` would skip most ticks.
   */
  sync(currentTick: number, visualTrackOrder: readonly string[]): void {
    if (this.disposed) return;
    this.syncResolvedForest(
      currentTick,
      visualTrackOrder,
      this.adjustmentEffectResolver.deriveGroups(currentTick),
    );
  }

  /**
   * Presentation-plan seam: graph/live/export callers hand in the adjustment
   * forest and track directives already derived from the same resolved jobs.
   * Pixi ownership stays here; no group or active-clip derivation is repeated.
   */
  syncPresentationPlan(
    currentTick: number,
    plan: ScenePresentationPlan,
  ): void {
    if (this.disposed) return;
    const visualTrackOrder = [...plan.tracks]
      .sort((left, right) => right.zIndex - left.zIndex)
      .map((command) => command.trackId);
    this.syncResolvedForest(
      currentTick,
      visualTrackOrder,
      plan.adjustmentForest,
    );
  }

  private syncResolvedForest(
    currentTick: number,
    visualTrackOrder: readonly string[],
    forest: readonly DerivedRenderGroup[],
  ): void {
    const visualIndexByTrackId = new Map<string, number>();
    visualTrackOrder.forEach((id, index) => {
      visualIndexByTrackId.set(id, index);
    });
    const zIndexForVisualIndex = (index: number): number =>
      visualTrackOrder.length - 1 - index;

    // 1. Walk the forest depth-first to enumerate every group node, its
    //    desired parent container, and its top-most member visual index.
    const entries: ForestEntry[] = [];
    const innermostGroupByTrack = new Map<string, DerivedRenderGroup>();
    const walk = (
      group: DerivedRenderGroup,
      parentContainer: Container,
    ): void => {
      // Compute or reuse this group's container.
      let container = this.groupContainers.get(group.id);
      if (!container) {
        container = new Container();
        container.sortableChildren = true;
        this.groupContainers.set(group.id, container);
      }

      let topMostVisualIndex = Number.MAX_SAFE_INTEGER;
      for (const trackId of group.trackIds) {
        const idx = visualIndexByTrackId.get(trackId);
        if (idx !== undefined && idx < topMostVisualIndex) {
          topMostVisualIndex = idx;
        }
        // Initially mark the track's innermost group as this one; nested
        // children below will overwrite for the tracks they cover.
        innermostGroupByTrack.set(trackId, group);
      }
      entries.push({
        group,
        desiredParent: parentContainer,
        topMostVisualIndex,
      });

      for (const child of group.children) {
        walk(child, container);
      }
    };
    for (const root of forest) {
      walk(root, this.root);
    }

    const activeGroupIds = new Set(entries.map((entry) => entry.group.id));
    const sortDirtyParents = new Set<Container>();

    // 2. Pre-prune: destroy any cached container whose id no longer appears
    //    in the forest (topology change — the source clip is gone or its
    //    reach now starts on a different first-track). Detach (but keep)
    //    containers that exist in the cache but aren't active this tick.
    for (const [groupId, container] of this.groupContainers) {
      if (activeGroupIds.has(groupId)) continue;
      if (container.parent) {
        if (container.children.length > 0) {
          container.removeChildren();
        }
        container.parent.removeChild(container);
      }
    }
    // (Containers stay cached when merely inactive; destroyed only on
    // dispose or when the orchestrator's setAdjustmentSource elides them.
    // Phase-3 keeps the cache permissive — the cache eviction policy can
    // tighten in a follow-up if memory pressure becomes a concern.)

    // 3. Reparent group containers to match the forest. Top-down so each
    //    child sees its desired parent already attached at the right level.
    for (const entry of entries) {
      const container = this.groupContainers.get(entry.group.id);
      if (!container) continue;
      if (container.parent !== entry.desiredParent) {
        if (container.parent && !container.parent.destroyed) {
          sortDirtyParents.add(container.parent);
        }
        entry.desiredParent.addChild(container);
        sortDirtyParents.add(entry.desiredParent);
      }
      const z =
        entry.topMostVisualIndex === Number.MAX_SAFE_INTEGER
          ? 0
          : zIndexForVisualIndex(entry.topMostVisualIndex);
      if (container.zIndex !== z) {
        container.zIndex = z;
        sortDirtyParents.add(entry.desiredParent);
      }
    }

    // 4. Reparent track engine containers to their innermost wrapping group
    //    (or root if none) and assign zIndex from visualTrackOrder.
    for (const [trackId, engineContainer] of this.tracks) {
      if (engineContainer.destroyed) continue;
      const innermost = innermostGroupByTrack.get(trackId);
      const desiredParent = innermost
        ? (this.groupContainers.get(innermost.id) ?? this.root)
        : this.root;
      if (engineContainer.parent !== desiredParent) {
        if (engineContainer.parent && !engineContainer.parent.destroyed) {
          sortDirtyParents.add(engineContainer.parent);
        }
        desiredParent.addChild(engineContainer);
        sortDirtyParents.add(desiredParent);
      }
      const visualIndex = visualIndexByTrackId.get(trackId);
      if (visualIndex !== undefined) {
        const z = zIndexForVisualIndex(visualIndex);
        if (engineContainer.zIndex !== z) {
          engineContainer.zIndex = z;
          sortDirtyParents.add(desiredParent);
        }
      }
    }

    // 5. Apply group transforms to each active group container.
    for (const entry of entries) {
      const container = this.groupContainers.get(entry.group.id);
      if (!container) continue;
      // The derived group exposes start/timelineDuration/transformations,
      // matching what applyGroupTransforms expects on its `group` arg.
      applyGroupTransforms(
        container,
        entry.group,
        this.logicalDimensions,
        currentTick,
      );
    }

    // 6. Re-sort dirty parents.
    for (const parent of sortDirtyParents) {
      if (parent.destroyed) continue;
      parent.sortChildren();
    }
  }

  /** Detach + destroy every cached group container and forget all state.
   *  Engine containers are not destroyed — they're owned by their engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const container of this.groupContainers.values()) {
      this.destroyGroupContainer(container);
    }
    this.groupContainers.clear();
    this.tracks.clear();
  }

  /** Test helper. Returns the cached Pixi container for a group, or null. */
  getGroupContainer(groupId: string): Container | null {
    return this.groupContainers.get(groupId) ?? null;
  }

  private destroyGroupContainer(container: Container): void {
    if (container.destroyed) return;
    if (container.children.length > 0) {
      container.removeChildren();
    }
    if (container.parent && !container.parent.destroyed) {
      container.parent.removeChild(container);
    }
    container.destroy({ children: false });
  }
}
