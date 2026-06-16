import { memo } from "react";
import { DragOverlay, useDndContext, type Modifier } from "@dnd-kit/core";
import { useInteractionStore } from "../../timeline/hooks/useInteractionStore";
import { TransformationCardSurface } from "./library/TransformationCard";
import type { TransformDragData } from "./library/TransformationCard";

const CARD_WIDTH = 220;
const CURSOR_OFFSET_PX = 14;

function isTransformDragData(data: unknown): data is TransformDragData {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type?: unknown }).type === "transform"
  );
}

/**
 * Pin the overlay's top-left to the cursor (with a small offset) instead of
 * relying on dnd-kit's default source-node positioning. The card lives in a
 * scrollable sidebar, so the measured source rect can place the default overlay
 * far off — even offscreen. This mirrors the timeline's `snapToCursorOffset`.
 */
const followCursor: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (!activatorEvent || !draggingNodeRect) {
    return transform;
  }

  const activator = activatorEvent as MouseEvent | TouchEvent;
  const clientX =
    "clientX" in activator ? activator.clientX : activator.touches[0]?.clientX;
  const clientY =
    "clientY" in activator ? activator.clientY : activator.touches[0]?.clientY;
  if (clientX == null || clientY == null) {
    return transform;
  }

  const pointerX = clientX + transform.x;
  const pointerY = clientY + transform.y;

  return {
    ...transform,
    x: pointerX + CURSOR_OFFSET_PX - draggingNodeRect.left,
    y: pointerY + CURSOR_OFFSET_PX - draggingNodeRect.top,
  };
};

function TransformationDragOverlayComponent() {
  const { active } = useDndContext();
  const compatible = useInteractionStore((state) =>
    state.transformDropPreview ? state.transformDropPreview.compatible : null,
  );
  const activeData = active?.data.current;

  if (!isTransformDragData(activeData)) {
    return null;
  }

  // The card follows the cursor for the whole drag as the "what am I dragging"
  // affordance; the in-timeline preview (clip outline / footprint rectangle /
  // interstitial gap line) shows where it will land. When the current target
  // is incompatible, the card reads red too.
  return (
    <DragOverlay dropAnimation={null} modifiers={[followCursor]}>
      <div style={{ width: CARD_WIDTH, pointerEvents: "none" }}>
        <TransformationCardSurface
          label={activeData.label}
          isRejected={compatible === false}
        />
      </div>
    </DragOverlay>
  );
}

export const TransformationDragOverlay = memo(
  TransformationDragOverlayComponent,
);
