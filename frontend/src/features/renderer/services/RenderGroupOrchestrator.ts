import { Container } from "pixi.js";
import type { TimelineGroup } from "../../../types/TimelineTypes";
import { isGroupActiveAtTick } from "../../../types/TimelineTypes";
import { applyGroupTransforms } from "../../transformations/applyGroupTransforms";

export interface RenderGroupOrchestratorOptions {
  /** Project resolution used by applyGroupTransforms. Defaults to 1920x1080
   *  until the caller wires the real logicalDimensions. */
  logicalDimensions?: { width: number; height: number };
}

/**
 * Owns Pixi-side parenting of track engine containers and time-bounded render
 * group containers under a shared `root` container (typically the
 * ExportRenderer's `logicalStage` or the Player's viewport).
 *
 * - Track engines register their containers once; the orchestrator decides
 *   their parent each tick based on which group (if any) is active over them.
 * - Group containers are cached: created lazily on first activation, retained
 *   when the group goes inactive (so re-entering its window is a cheap
 *   re-attach), and destroyed only when the group itself is removed from the
 *   model (via `setGroups`) or when the orchestrator is disposed.
 * - All ordering follows the codebase's z-index convention
 *   (`visualTrackOrder.length - 1 - index`); a group container sits at the
 *   slot of its top-most member.
 */
export class RenderGroupOrchestrator {
  private readonly root: Container;
  private readonly tracks = new Map<string, Container>();
  private readonly groupDefs = new Map<string, TimelineGroup>();
  private readonly groupContainers = new Map<string, Container>();
  private logicalDimensions: { width: number; height: number };
  private disposed = false;

  constructor(root: Container, options: RenderGroupOrchestratorOptions = {}) {
    this.root = root;
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
   * Update the group definitions. Groups removed from the model have their
   * cached container detached and destroyed (children: false — the engine
   * containers underneath are owned by their TrackRenderEngine). Does not
   * reparent registered tracks; that happens on the next `sync()`.
   */
  setGroups(groups: readonly TimelineGroup[]): void {
    if (this.disposed) return;
    const nextIds = new Set(groups.map((g) => g.id));
    for (const [id, container] of this.groupContainers) {
      if (nextIds.has(id)) continue;
      this.destroyGroupContainer(container);
      this.groupContainers.delete(id);
    }
    this.groupDefs.clear();
    for (const group of groups) {
      this.groupDefs.set(group.id, group);
    }
  }

  /**
   * Rewrite parenting for the current tick. Diffs against the orchestrator's
   * internal cache and applies the minimum reparenting. Order: per-clip
   * transforms (run inside engine.update() / awaited synchronized renderers)
   * MUST complete before this call; renderer.render(...) MUST be called after.
   */
  sync(currentTick: number, visualTrackOrder: readonly string[]): void {
    if (this.disposed) return;

    const visualIndexByTrackId = new Map<string, number>();
    visualTrackOrder.forEach((id, index) => {
      visualIndexByTrackId.set(id, index);
    });
    const zIndexForVisualIndex = (index: number): number =>
      visualTrackOrder.length - 1 - index;

    // 1. For each registered track, pick its single active group (if any).
    const activeGroupByTrack = new Map<string, TimelineGroup>();
    for (const group of this.groupDefs.values()) {
      if (!isGroupActiveAtTick(group, currentTick)) continue;
      for (const trackId of group.trackIds) {
        if (this.tracks.has(trackId)) {
          activeGroupByTrack.set(trackId, group);
        }
      }
    }

    // 2. Active groups = groups with at least one registered member track.
    const activeGroupIds = new Set<string>();
    for (const group of activeGroupByTrack.values()) {
      activeGroupIds.add(group.id);
    }

    const sortDirtyParents = new Set<Container>();

    // 3. Ensure each active group has an attached container; detach inactive
    //    group containers (without destroying them).
    for (const groupId of activeGroupIds) {
      let container = this.groupContainers.get(groupId);
      if (!container) {
        container = new Container();
        container.sortableChildren = true;
        this.groupContainers.set(groupId, container);
      }
      if (container.parent !== this.root) {
        this.root.addChild(container);
        sortDirtyParents.add(this.root);
      }
    }
    for (const [groupId, container] of this.groupContainers) {
      if (activeGroupIds.has(groupId)) continue;
      if (container.parent) {
        // Detach the group's children first so they don't ride along into
        // the detached subtree (they'll be reparented in step 4 anyway, but
        // belt-and-braces keeps the scene graph consistent between steps).
        if (container.children.length > 0) {
          container.removeChildren();
        }
        container.parent.removeChild(container);
      }
    }

    // 4. Reparent track engine containers; assign per-track zIndex.
    for (const [trackId, engineContainer] of this.tracks) {
      if (engineContainer.destroyed) continue;
      const activeGroup = activeGroupByTrack.get(trackId);
      const desiredParent = activeGroup
        ? this.groupContainers.get(activeGroup.id) ?? this.root
        : this.root;
      if (engineContainer.parent !== desiredParent) {
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

    // 5. Assign zIndex to active group containers based on their top-most
    //    member (lowest visual index). Apply visibility + transforms.
    for (const groupId of activeGroupIds) {
      const container = this.groupContainers.get(groupId);
      const group = this.groupDefs.get(groupId);
      if (!container || !group) continue;

      let minVisualIndex = Number.MAX_SAFE_INTEGER;
      for (const trackId of group.trackIds) {
        if (!this.tracks.has(trackId)) continue;
        const idx = visualIndexByTrackId.get(trackId);
        if (idx !== undefined && idx < minVisualIndex) {
          minVisualIndex = idx;
        }
      }
      const z =
        minVisualIndex === Number.MAX_SAFE_INTEGER
          ? 0
          : zIndexForVisualIndex(minVisualIndex);
      if (container.zIndex !== z) {
        container.zIndex = z;
        sortDirtyParents.add(this.root);
      }
      container.visible = group.isVisible;
      applyGroupTransforms(container, group, this.logicalDimensions, currentTick);
    }

    // 6. Re-sort any parent that received reparenting / zIndex changes.
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
    this.groupDefs.clear();
    this.tracks.clear();
  }

  /** Test helper. Returns the cached Pixi container for a group, or null. */
  getGroupContainer(groupId: string): Container | null {
    return this.groupContainers.get(groupId) ?? null;
  }

  private destroyGroupContainer(container: Container): void {
    if (container.destroyed) return;
    if (container.children.length > 0) {
      // Detach engine containers before destroying so they aren't orphaned
      // under a destroyed parent reference.
      container.removeChildren();
    }
    if (container.parent && !container.parent.destroyed) {
      container.parent.removeChild(container);
    }
    container.destroy({ children: false });
  }
}
