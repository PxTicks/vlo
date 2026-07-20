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
  setViewVisible(viewId: string, visible: boolean): void;
  moveView(viewId: string, delta: -1 | 1): void;
  resetLayout(): void;
}

export function useViewRegion(region: HostViewRegion): ViewRegionState {
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
    views.find((view) => view.source === "host")?.id ??
    views[0]?.id ??
    null;
  const selectView = useCallback(
    (viewId: string) => hostViewRegistry.select(region, viewId),
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
    setViewVisible: (viewId, visible) =>
      hostViewRegistry.setUserVisible(viewId, visible),
    moveView: (viewId, delta) => hostViewRegistry.move(viewId, delta),
    resetLayout,
  };
}
