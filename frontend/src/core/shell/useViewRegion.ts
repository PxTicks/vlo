import { useCallback, useSyncExternalStore } from "react";
import { hostContextKeys } from "./contextKeys";
import { isDockRegion, type DockRegion } from "./layout/layoutTypes";
import { useShellLayoutStore } from "./layout/useShellLayoutStore";
import { focusShellViewWhenPlaced } from "./shellViewPlacement";
import {
  hostViewRegistry,
  type HostViewRegion,
  type ShellViewEntry,
} from "./viewRegistry";

export interface ViewRegionState {
  readonly views: readonly ShellViewEntry[];
  readonly allViews: readonly ShellViewEntry[];
  readonly selectedViewId: string | null;
  isViewVisible(viewId: string): boolean;
  selectView(viewId: string): boolean;
  /** Drops the region's selection. Only meaningful without `autoSelect`. */
  closeRegion(): void;
  setViewVisible(viewId: string, visible: boolean): void;
  moveView(viewId: string, delta: -1 | 1): void;
  /**
   * Moves a panel to another of its allowed regions and reveals it there.
   * Returns false for a region the panel does not permit, and always false
   * outside the docking model.
   */
  movePanelToRegion(viewId: string, region: DockRegion): boolean;
  resetLayout(): void;
}

export interface ViewRegionOptions {
  /**
   * Whether an unselected region falls back to its first view. Sidebars always
   * show something, so they do; a collapsible dock must not, or it would open
   * itself the moment anything registers into it.
   *
   * Dock regions declare this in `DOCK_REGION_CONSTRAINTS` instead, so the
   * resolver applies one rule for every consumer; the option only governs
   * `projects-page.main`.
   */
  readonly autoSelect?: boolean;
}

function useRegistryRevision(): void {
  useSyncExternalStore(
    (listener) => {
      const unsubscribeViews = hostViewRegistry.subscribe(listener);
      const unsubscribeContext = hostContextKeys.subscribe(listener);
      return () => {
        unsubscribeViews();
        unsubscribeContext();
      };
    },
    () => `${hostViewRegistry.getRevision()}:${hostContextKeys.getRevision()}`,
    () => `${hostViewRegistry.getRevision()}:${hostContextKeys.getRevision()}`,
  );
}

function entriesOf(viewIds: readonly string[]): readonly ShellViewEntry[] {
  return viewIds
    .map((viewId) => hostViewRegistry.get(viewId))
    .filter((entry): entry is ShellViewEntry => entry !== undefined);
}

export function useViewRegion(
  region: HostViewRegion,
  options: ViewRegionOptions = {},
): ViewRegionState {
  useRegistryRevision();
  // Placement, ordering, visibility, and selection for a dock region are
  // resolved layout state; the registry only supplies the entries behind the
  // IDs. Reading both keeps this hook the single translation point.
  const resolved = useShellLayoutStore((state) =>
    isDockRegion(region) ? state.resolved.regions[region] : null,
  );
  // Selection goes through the registry for every region: for a dock region it
  // forwards to the layout kernel, so a component and a feature calling the
  // same operation cannot diverge.
  const selectView = useCallback(
    (viewId: string) => hostViewRegistry.select(region, viewId),
    [region],
  );
  const closeRegion = useCallback(
    () => hostViewRegistry.clearSelection(region),
    [region],
  );
  const setViewVisible = useCallback(
    (viewId: string, visible: boolean) => {
      if (isDockRegion(region)) {
        useShellLayoutStore.getState().setPanelVisible(viewId, visible);
        return;
      }
      hostViewRegistry.setUserVisible(viewId, visible);
    },
    [region],
  );
  const moveView = useCallback(
    (viewId: string, delta: -1 | 1) => {
      if (isDockRegion(region)) {
        useShellLayoutStore.getState().reorderPanel(viewId, delta);
        return;
      }
      hostViewRegistry.move(viewId, delta);
    },
    [region],
  );
  const movePanelToRegion = useCallback(
    (viewId: string, target: DockRegion) => {
      if (!isDockRegion(region)) return false;
      const moved = useShellLayoutStore.getState().movePanel(viewId, target);
      // Focus follows the panel: where it went is the only thing guaranteed to
      // still be on screen afterwards.
      if (moved) focusShellViewWhenPlaced(viewId);
      return moved;
    },
    [region],
  );
  const resetLayout = useCallback(() => {
    if (isDockRegion(region)) {
      useShellLayoutStore.getState().resetRegion(region);
      return;
    }
    hostViewRegistry.resetRegion(region);
  }, [region]);

  // Recomputed every render, as the registry listing always was: the revision
  // subscription above is what guarantees a re-render when the table changes.
  const views =
    resolved === null
      ? hostViewRegistry.list(region)
      : entriesOf(resolved.orderedViewIds);
  const allViews =
    resolved === null
      ? hostViewRegistry.list(region, {
          includeHidden: true,
          includeUnavailable: true,
        })
      : entriesOf(resolved.placedViewIds);

  const autoSelect = options.autoSelect ?? true;
  const selectedViewId =
    resolved !== null
      ? resolved.selectedViewId
      : (hostViewRegistry.getSelected(region) ??
        (autoSelect
          ? (views.find((view) => view.source === "host")?.id ??
            views[0]?.id ??
            null)
          : null));

  return {
    views,
    allViews,
    selectedViewId,
    // Visibility is the user's intent, not the outcome: an unavailable panel is
    // absent from `orderedViewIds` but still shows as visible, because that is
    // what the checkbox is promising to restore.
    isViewVisible: (viewId) =>
      resolved === null
        ? hostViewRegistry.isUserVisible(viewId)
        : useShellLayoutStore.getState().document.panels[viewId]?.visible !==
          false,
    selectView,
    closeRegion,
    setViewVisible,
    moveView,
    movePanelToRegion,
    resetLayout,
  };
}
