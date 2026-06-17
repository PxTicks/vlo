import type { Modifier } from "@dnd-kit/core";
import { CLIP_HEIGHT } from "../../constants";

export const ASSET_DRAG_OFFSET_X = 60;
export const GHOST_CLIP_HEIGHT = CLIP_HEIGHT;

/**
 * Calculates the visual position of a ghost clip based on the cursor position.
 * Returns the top-left coordinates (x, y).
 */
export const getGhostClipPosition = (
  cursorX: number,
  cursorY: number,
  height: number = GHOST_CLIP_HEIGHT,
) => {
  return {
    x: cursorX - ASSET_DRAG_OFFSET_X,
    y: cursorY - height / 2,
  };
};

/**
 * Dnd-kit Modifier to snap the overlay to the cursor using the shared geometry logic.
 */
export const snapToCursorOffset: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  overlayNodeRect,
  transform,
}) => {
  if (!activatorEvent || !draggingNodeRect || !overlayNodeRect) {
    return transform;
  }

  const activator = activatorEvent as MouseEvent | TouchEvent;

  // Check if we have pointer coordinates (Mouse or Touch)
  const isPointer =
    "clientX" in activator ||
    ("touches" in activator && activator.touches.length > 0);

  if (!isPointer) {
    return transform;
  }

  const clientX =
    "clientX" in activator ? activator.clientX : activator.touches[0].clientX;
  const clientY =
    "clientY" in activator ? activator.clientY : activator.touches[0].clientY;

  // 1. Calculate Current Mouse Position
  const currentMouseX = clientX + transform.x;
  const currentMouseY = clientY + transform.y;

  // 2. Get Target Position using shared logic
  const { x: targetX, y: targetY } = getGhostClipPosition(
    currentMouseX,
    currentMouseY,
    GHOST_CLIP_HEIGHT, // Force use of constant height for consistent vertical centering
  );

  // 3. Calculate the Transform needed to move from Initial Source to Target
  const x = targetX - draggingNodeRect.left;
  const y = targetY - draggingNodeRect.top;

  return { ...transform, x, y };
};
