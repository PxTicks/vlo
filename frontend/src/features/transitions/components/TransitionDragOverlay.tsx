import { memo } from "react";
import {
  DragOverlay,
  useDndContext,
  type Modifier,
} from "@dnd-kit/core";
import { useInteractionStore } from "../../timeline/hooks/useInteractionStore";
import {
  TransitionCardSurface,
  type TransitionDragData,
} from "./TransitionCard";

function isTransitionDragData(data: unknown): data is TransitionDragData {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type?: unknown }).type === "transition"
  );
}

const followCursor: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const event = activatorEvent as MouseEvent | TouchEvent;
  const clientX =
    "clientX" in event ? event.clientX : event.touches[0]?.clientX;
  const clientY =
    "clientY" in event ? event.clientY : event.touches[0]?.clientY;
  if (clientX == null || clientY == null) return transform;
  return {
    ...transform,
    x: clientX + transform.x - draggingNodeRect.left,
    y:
      clientY +
      transform.y -
      draggingNodeRect.height / 2 -
      draggingNodeRect.top,
  };
};

function TransitionDragOverlayComponent() {
  const { active } = useDndContext();
  const preview = useInteractionStore((state) => state.transitionDropPreview);
  const data = active?.data.current;
  if (!isTransitionDragData(data)) return null;

  return (
    <DragOverlay dropAnimation={null} modifiers={[followCursor]}>
      <div style={{ width: 220, pointerEvents: "none" }}>
        <TransitionCardSurface
          label={data.label}
          glyph={data.glyph}
          rejected={preview?.compatible === false}
        />
      </div>
    </DragOverlay>
  );
}

export const TransitionDragOverlay = memo(TransitionDragOverlayComponent);
