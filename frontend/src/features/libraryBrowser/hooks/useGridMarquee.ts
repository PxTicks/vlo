import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  getItemIndicesInRect,
  rectFromPoints,
  type GridGeometry,
  type MarqueePoint,
} from "../utils/marqueeGeometry";

// Below this distance a press on empty space stays a background click.
const DRAG_THRESHOLD_PX = 4;
const AUTOSCROLL_EDGE_PX = 32;
const AUTOSCROLL_MAX_SPEED_PX = 18;

export interface LibraryBrowserMarqueeHandlers {
  /**
   * Called once the drag passes the click threshold. `additive` is true when
   * the drag began with Ctrl/Cmd/Shift held, so the host can merge the marquee
   * with the selection it had at this moment instead of replacing it.
   */
  onStart?: (options: { additive: boolean }) => void;
  /** The ids under the marquee, in item order; fires only when the set changes. */
  onChange: (itemIds: readonly string[]) => void;
  onEnd?: () => void;
}

interface UseGridMarqueeOptions {
  handlers: LibraryBrowserMarqueeHandlers | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
  itemCount: number;
  getGeometry: () => GridGeometry;
  getItemIdAt: (index: number) => string;
}

interface MarqueeSession {
  anchor: MarqueePoint;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  additive: boolean;
  active: boolean;
  lastKey: string | null;
  frameId: number | null;
  detach: () => void;
}

function toContentPoint(
  scrollElement: HTMLElement,
  clientX: number,
  clientY: number,
): MarqueePoint {
  const bounds = scrollElement.getBoundingClientRect();
  return {
    x: Math.min(
      Math.max(clientX - bounds.left + scrollElement.scrollLeft, 0),
      scrollElement.clientWidth,
    ),
    y: Math.min(
      Math.max(clientY - bounds.top + scrollElement.scrollTop, 0),
      scrollElement.scrollHeight,
    ),
  };
}

/** Scroll speed ramps with how far the pointer sits into (or past) an edge. */
function getAutoScrollDelta(bounds: DOMRect, clientY: number): number {
  const topDepth = bounds.top + AUTOSCROLL_EDGE_PX - clientY;
  if (topDepth > 0) {
    return (
      -Math.min(topDepth / AUTOSCROLL_EDGE_PX, 1) * AUTOSCROLL_MAX_SPEED_PX
    );
  }
  const bottomDepth = clientY - (bounds.bottom - AUTOSCROLL_EDGE_PX);
  if (bottomDepth > 0) {
    return (
      Math.min(bottomDepth / AUTOSCROLL_EDGE_PX, 1) * AUTOSCROLL_MAX_SPEED_PX
    );
  }
  return 0;
}

/**
 * Rubber-band selection that starts from empty grid space. Pointer tracking is
 * imperative (window listeners + a ref-styled overlay) so a drag never
 * re-renders the grid; only selection changes reach React, via the host.
 */
export function useGridMarquee({
  handlers,
  scrollRef,
  overlayRef,
  itemCount,
  getGeometry,
  getItemIdAt,
}: UseGridMarqueeOptions) {
  const latestRef = useRef({ handlers, itemCount, getGeometry, getItemIdAt });
  useLayoutEffect(() => {
    latestRef.current = { handlers, itemCount, getGeometry, getItemIdAt };
  });
  const sessionRef = useRef<MarqueeSession | null>(null);
  const suppressClickRef = useRef(false);

  const updateSelection = useCallback(() => {
    const session = sessionRef.current;
    const scrollElement = scrollRef.current;
    if (!session?.active || !scrollElement) {
      return;
    }

    const current = toContentPoint(
      scrollElement,
      session.clientX,
      session.clientY,
    );
    const rect = rectFromPoints(session.anchor, current);

    const overlay = overlayRef.current;
    if (overlay) {
      overlay.style.display = "block";
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.right - rect.left}px`;
      overlay.style.height = `${rect.bottom - rect.top}px`;
    }

    const { handlers, itemCount, getGeometry, getItemIdAt } = latestRef.current;
    const itemIds = getItemIndicesInRect(rect, getGeometry(), itemCount).map(
      getItemIdAt,
    );
    const key = itemIds.join("\u0000");
    if (key !== session.lastKey) {
      session.lastKey = key;
      handlers?.onChange(itemIds);
    }
  }, [overlayRef, scrollRef]);

  const endSession = useCallback(
    (commit: boolean) => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      sessionRef.current = null;
      session.detach();
      if (session.frameId !== null) {
        cancelAnimationFrame(session.frameId);
      }

      if (overlayRef.current) {
        overlayRef.current.style.display = "none";
      }

      if (!session.active) {
        return;
      }

      // The release still dispatches a click on the scroll region, which the
      // host treats as "clear selection"; swallow just that one.
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);

      if (commit) {
        latestRef.current.handlers?.onEnd?.();
      }
    },
    [overlayRef],
  );

  useEffect(() => () => endSession(false), [endSession]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const scrollElement = scrollRef.current;
      const { handlers, itemCount } = latestRef.current;
      if (
        !handlers ||
        !scrollElement ||
        itemCount === 0 ||
        event.button !== 0 ||
        event.pointerType === "touch" ||
        sessionRef.current
      ) {
        return;
      }

      // Only empty space starts a marquee: a filler slot, a gap, or the part
      // of an item cell its content doesn't cover.
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const itemCell = target.closest("[data-library-item-id]");
      if (itemCell && itemCell !== target) {
        return;
      }

      // Pressing the scrollbar must keep scrolling, not draw a marquee.
      const bounds = scrollElement.getBoundingClientRect();
      if (event.clientX - bounds.left >= scrollElement.clientWidth) {
        return;
      }

      // Cancelling the press keeps the browser from moving DOM focus to the
      // nearest focusable ancestor (a shell region with no editor-region
      // attribute), which would revoke the keyboard claim and leave Delete
      // dead for the new selection. It also stops a text selection starting.
      event.preventDefault();

      function autoScrollFrame() {
        const session = sessionRef.current;
        if (!session?.active || !scrollElement) {
          return;
        }
        const delta = getAutoScrollDelta(
          scrollElement.getBoundingClientRect(),
          session.clientY,
        );
        if (delta !== 0) {
          const previousScrollTop = scrollElement.scrollTop;
          scrollElement.scrollTop += delta;
          if (scrollElement.scrollTop !== previousScrollTop) {
            updateSelection();
          }
        }
        session.frameId = requestAnimationFrame(autoScrollFrame);
      }

      const handleMove = (moveEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || moveEvent.pointerId !== event.pointerId) {
          return;
        }
        session.clientX = moveEvent.clientX;
        session.clientY = moveEvent.clientY;

        if (!session.active) {
          const distance = Math.hypot(
            moveEvent.clientX - session.startClientX,
            moveEvent.clientY - session.startClientY,
          );
          if (distance < DRAG_THRESHOLD_PX) {
            return;
          }
          session.active = true;
          latestRef.current.handlers?.onStart?.({ additive: session.additive });
          session.frameId = requestAnimationFrame(autoScrollFrame);
        }

        updateSelection();
      };
      const handleUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId === event.pointerId) {
          // The release can land somewhere no pointermove reported, so commit
          // the marquee at the release point rather than the last move.
          handleMove(upEvent);
          endSession(true);
        }
      };
      const handleCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === event.pointerId) {
          endSession(false);
        }
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);

      sessionRef.current = {
        anchor: toContentPoint(scrollElement, event.clientX, event.clientY),
        startClientX: event.clientX,
        startClientY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
        active: false,
        lastKey: null,
        frameId: null,
        detach: () => {
          window.removeEventListener("pointermove", handleMove);
          window.removeEventListener("pointerup", handleUp);
          window.removeEventListener("pointercancel", handleCancel);
        },
      };
    },
    [endSession, scrollRef, updateSelection],
  );

  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClickRef.current) {
      return false;
    }
    suppressClickRef.current = false;
    return true;
  }, []);

  return { handlePointerDown, consumeSuppressedClick };
}
