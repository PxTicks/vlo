import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Box } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import type { ResizableShellRegion } from "../layout/layoutTypes";
import { useShellLayoutStore } from "../layout/useShellLayoutStore";

const KEYBOARD_RESIZE_STEP_PX = 16;

type SeparatorEdge = "left" | "right" | "top";

interface RegionSeparatorProps {
  readonly region: ResizableShellRegion;
  readonly label: string;
  /** The edge of the region on which the separator is mounted. */
  readonly edge: SeparatorEdge;
  readonly controls: string;
}

function eventCoordinate(event: globalThis.PointerEvent, edge: SeparatorEdge) {
  return edge === "top" ? event.clientY : event.clientX;
}

function growthDirection(edge: SeparatorEdge): 1 | -1 {
  return edge === "right" ? 1 : -1;
}

/** Accessible pointer and keyboard resizing for one constrained shell region. */
export function RegionSeparator({
  region,
  label,
  edge,
  controls,
}: RegionSeparatorProps) {
  const geometry = useShellLayoutStore(
    useShallow((state) => {
      const resolved =
        region === "lower-stage"
          ? state.resolved.lowerStage
          : state.resolved.regions[region];
      return {
        collapsed: resolved.collapsed,
        sizePx: resolved.sizePx,
        userSizePx: resolved.userSizePx,
        minimumSizePx: resolved.minimumSizePx,
        maximumSizePx: resolved.maximumSizePx,
        resizeRegion: state.resizeRegion,
        setRegionCollapsed: state.setRegionCollapsed,
        resetRegionSize: state.resetRegionSize,
        flushPersistence: state.flushPersistence,
      };
    }),
  );
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
    },
    [],
  );

  const resizeTo = (sizePx: number): void => {
    if (geometry.collapsed) {
      geometry.setRegionCollapsed(region, false);
    }
    geometry.resizeRegion(region, sizePx);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupDragRef.current?.();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startCoordinate =
      edge === "top" ? event.clientY : event.clientX;
    const startSize = geometry.userSizePx;
    const direction = growthDirection(edge);
    const documentElement = globalThis.document.documentElement;
    const previousUserSelect = documentElement.style.userSelect;
    documentElement.style.userSelect = "none";
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Pointer capture can reject if the pointer ended during dispatch.
    }

    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const delta = eventCoordinate(moveEvent, edge) - startCoordinate;
      resizeTo(startSize + delta * direction);
    };
    const cleanup = (): void => {
      globalThis.removeEventListener("pointermove", handleMove);
      globalThis.removeEventListener("pointerup", handleEnd);
      globalThis.removeEventListener("pointercancel", handleEnd);
      globalThis.removeEventListener("blur", handleEnd);
      documentElement.style.userSelect = previousUserSelect;
      try {
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
        // Losing capture is already a completed drag.
      }
      cleanupDragRef.current = null;
    };
    const handleEnd = (): void => {
      cleanup();
      geometry.flushPersistence();
    };

    cleanupDragRef.current = cleanup;
    globalThis.addEventListener("pointermove", handleMove);
    globalThis.addEventListener("pointerup", handleEnd);
    globalThis.addEventListener("pointercancel", handleEnd);
    globalThis.addEventListener("blur", handleEnd);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let nextSize: number | null = null;
    if (event.key === "Home") nextSize = geometry.minimumSizePx;
    else if (event.key === "End") nextSize = geometry.maximumSizePx;
    else if (edge === "top" && event.key === "ArrowUp") {
      nextSize = geometry.userSizePx + KEYBOARD_RESIZE_STEP_PX;
    } else if (edge === "top" && event.key === "ArrowDown") {
      nextSize = geometry.userSizePx - KEYBOARD_RESIZE_STEP_PX;
    } else if (edge === "right" && event.key === "ArrowRight") {
      nextSize = geometry.userSizePx + KEYBOARD_RESIZE_STEP_PX;
    } else if (edge === "right" && event.key === "ArrowLeft") {
      nextSize = geometry.userSizePx - KEYBOARD_RESIZE_STEP_PX;
    } else if (edge === "left" && event.key === "ArrowLeft") {
      nextSize = geometry.userSizePx + KEYBOARD_RESIZE_STEP_PX;
    } else if (edge === "left" && event.key === "ArrowRight") {
      nextSize = geometry.userSizePx - KEYBOARD_RESIZE_STEP_PX;
    } else if (event.key === "Enter") {
      event.preventDefault();
      geometry.setRegionCollapsed(region, !geometry.collapsed);
      return;
    }

    if (nextSize === null) return;
    event.preventDefault();
    event.stopPropagation();
    resizeTo(nextSize);
    geometry.flushPersistence();
  };

  const vertical = edge !== "top";
  return (
    <Box
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${label.toLowerCase()}`}
      aria-controls={controls}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={Math.min(geometry.minimumSizePx, geometry.sizePx)}
      aria-valuemax={geometry.maximumSizePx}
      aria-valuenow={geometry.sizePx}
      aria-valuetext={
        geometry.collapsed
          ? `Collapsed, ${geometry.userSizePx} pixels retained`
          : geometry.sizePx === geometry.userSizePx
            ? `${geometry.sizePx} pixels`
            : `${geometry.sizePx} pixels visible, ${geometry.userSizePx} pixels preferred`
      }
      data-testid={`region-separator-${region}`}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => geometry.resetRegionSize(region)}
      sx={{
        position: "absolute",
        zIndex: 120,
        ...(vertical
          ? {
              top: 0,
              bottom: 0,
              width: 7,
              cursor: "col-resize",
              [edge]: 0,
            }
          : {
              top: 0,
              left: 0,
              right: 0,
              height: 7,
              cursor: "row-resize",
            }),
        touchAction: "none",
        outline: "none",
        "&::after": {
          content: '""',
          position: "absolute",
          ...(vertical
            ? { top: 0, bottom: 0, left: 3, width: 1 }
            : { left: 0, right: 0, top: 3, height: 1 }),
          bgcolor: "transparent",
        },
        "&:hover::after, &:focus-visible::after": {
          bgcolor: "primary.main",
        },
        "&:focus-visible": {
          bgcolor: "rgba(33, 150, 243, 0.16)",
        },
      }}
    />
  );
}
