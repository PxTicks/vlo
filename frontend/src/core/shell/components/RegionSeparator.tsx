import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Box } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import type { ResizableShellRegion } from "../layout/layoutTypes";
import { useShellLayoutStore } from "../layout/useShellLayoutStore";

const KEYBOARD_RESIZE_STEP_PX = 16;
// Roughly one CSS centimetre: enough overshoot to distinguish collapse intent
// from an ordinary attempt to reach the minimum size.
const COLLAPSE_DRAG_THRESHOLD_PX = 36;

type SeparatorEdge = "left" | "right" | "top";

const SEPARATOR_INDICATOR_POSITION = {
  left: { top: 0, bottom: 0, left: 0, width: "2px" },
  right: { top: 0, right: 0, bottom: 0, width: "2px" },
  top: { top: 0, right: 0, left: 0, height: "2px" },
} as const;

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
    const state = useShellLayoutStore.getState();
    const resolved =
      region === "lower-stage"
        ? state.resolved.lowerStage
        : state.resolved.regions[region];
    if (resolved.collapsed) {
      state.setRegionCollapsed(region, false);
    }
    state.resizeRegion(region, sizePx);
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
    const startCollapsed = geometry.collapsed;
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
      const growthDelta = delta * direction;
      if (startCollapsed) {
        // The collapsed rail is an inert grab target until the pointer moves
        // out toward the panel's expanded direction.
        if (growthDelta <= 0) return;
        resizeTo(startSize + growthDelta);
        return;
      }
      const nextSize = startSize + growthDelta;
      if (nextSize <= geometry.minimumSizePx - COLLAPSE_DRAG_THRESHOLD_PX) {
        const state = useShellLayoutStore.getState();
        // A single large pointer move should restore to the same minimum as a
        // gradual drag, rather than retaining an unrelated wider preference.
        state.resizeRegion(region, geometry.minimumSizePx);
        state.setRegionCollapsed(region, true);
        return;
      }
      resizeTo(nextSize);
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
        "&:hover > [data-separator-indicator], &:focus-visible > [data-separator-indicator]":
          {
            bgcolor: "primary.main",
          },
        "&:focus-visible": {
          bgcolor: "rgba(33, 150, 243, 0.16)",
        },
      }}
    >
      <Box
        aria-hidden="true"
        data-separator-indicator
        data-testid={"region-separator-indicator-" + region}
        sx={{
          position: "absolute",
          pointerEvents: "none",
          bgcolor: "transparent",
          ...SEPARATOR_INDICATOR_POSITION[edge],
        }}
      />
    </Box>
  );
}
