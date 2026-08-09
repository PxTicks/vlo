import { useLayoutEffect, useSyncExternalStore } from "react";
import { hostContextKeys } from "../contextKeys";
import { hostViewRegistry } from "../viewRegistry";
import { describeShellPanels } from "./layoutDescriptors";
import { useShellLayoutStore } from "./useShellLayoutStore";

/**
 * Connects the pure layout kernel to the live shell registries and viewport.
 * EditorLayout calls this once; layout components only consume resolved state.
 */
export function useShellLayoutRuntime(): void {
  const registryRevision = useSyncExternalStore(
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

  useLayoutEffect(() => {
    useShellLayoutStore.getState().setPanelDescriptors(describeShellPanels());
  }, [registryRevision]);

  useLayoutEffect(() => {
    const updateViewport = (): void => {
      useShellLayoutStore.getState().setViewport({
        widthPx: globalThis.innerWidth,
        heightPx: globalThis.innerHeight,
      });
    };
    const flushPersistence = (): void => {
      useShellLayoutStore.getState().flushPersistence();
    };

    updateViewport();
    globalThis.addEventListener("resize", updateViewport);
    globalThis.addEventListener("pagehide", flushPersistence);
    return () => {
      globalThis.removeEventListener("resize", updateViewport);
      globalThis.removeEventListener("pagehide", flushPersistence);
      flushPersistence();
    };
  }, []);
}
