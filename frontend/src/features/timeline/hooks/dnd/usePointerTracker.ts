import { useEffect, useRef } from "react";

export interface PointerPosition {
  x: number;
  y: number;
}

/**
 * Tracks the latest pointer position in viewport coordinates via a global
 * capture-phase `pointermove` listener.
 *
 * Drag flows read this ref to position ghosts and resolve drops from the raw
 * cursor, independently of dnd-kit's per-node delta bookkeeping (which is
 * unreliable for items dragged in from outside the timeline, e.g. asset cards
 * and transform cards).
 */
export function usePointerTracker() {
  const cursorRef = useRef<PointerPosition | null>(null);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      cursorRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", handlePointerMove, {
      capture: true,
    });
    return () =>
      window.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
  }, []);

  return cursorRef;
}
