import { useLayoutEffect } from "react";
import { useShellLayoutStore } from "./useShellLayoutStore";

/**
 * Connects the pure layout kernel to the viewport and the page lifecycle.
 * EditorLayout calls this once; layout components only consume resolved state.
 *
 * The panel table is not wired here: the store follows the registry on its own
 * so that placement is answerable before, and independently of, any render.
 */
export function useShellLayoutRuntime(): void {
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
