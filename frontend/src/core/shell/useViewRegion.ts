import { useCallback, useSyncExternalStore } from "react";
import { hostContextKeys } from "./contextKeys";
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
  resetLayout(): void;
}

export interface ViewRegionOptions {
  /**
   * Whether an unselected region falls back to its first view. Sidebars always
   * show something, so they do; a collapsible dock must not, or it would open
   * itself the moment anything registers into it.
   */
  readonly autoSelect?: boolean;
}

export function useViewRegion(
  region: HostViewRegion,
  options: ViewRegionOptions = {},
): ViewRegionState {
  const autoSelect = options.autoSelect ?? true;
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
  const views = hostViewRegistry.list(region);
  const selectedViewId =
    hostViewRegistry.getSelected(region) ??
    (autoSelect
      ? views.find((view) => view.source === "host")?.id ?? views[0]?.id ?? null
      : null);
  const selectView = useCallback(
    (viewId: string) => hostViewRegistry.select(region, viewId),
    [region],
  );
  const closeRegion = useCallback(
    () => hostViewRegistry.clearSelection(region),
    [region],
  );
  const resetLayout = useCallback(
    () => hostViewRegistry.resetRegion(region),
    [region],
  );

  return {
    views,
    allViews: hostViewRegistry.list(region, {
      includeHidden: true,
      includeUnavailable: true,
    }),
    selectedViewId,
    isViewVisible: (viewId) => hostViewRegistry.isUserVisible(viewId),
    selectView,
    closeRegion,
    setViewVisible: (viewId, visible) =>
      hostViewRegistry.setUserVisible(viewId, visible),
    moveView: (viewId, delta) => hostViewRegistry.move(viewId, delta),
    resetLayout,
  };
}
