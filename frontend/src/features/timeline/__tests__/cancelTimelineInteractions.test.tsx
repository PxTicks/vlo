/**
 * Scenario 12 of the docking plan's end-to-end list: start a timeline drag,
 * have the shell take the timeline away, and verify no stuck pointer or edit
 * state is left behind (docs/configurable-docking-and-dedicated-workspaces-plan.md
 * §7 Phase D, §8.4).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTimelineInteractions } from "../cancelTimelineInteractions";
import { useInteractionStore } from "../hooks/useInteractionStore";

function DragHandle() {
  const { setNodeRef, listeners, attributes } = useDraggable({ id: "clip_1" });
  return (
    <button
      type="button"
      ref={setNodeRef}
      data-testid="drag-handle"
      {...listeners}
      {...attributes}
    />
  );
}

function renderDraggable() {
  const onDragCancel = vi.fn();
  const onDragEnd = vi.fn();
  const onDragStart = vi.fn();

  function Harness() {
    // The same sensor the editor installs, so the cancel path under test is
    // the one production uses.
    const sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 1 } }),
    );
    return (
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <DragHandle />
      </DndContext>
    );
  }

  render(<Harness />);
  return { onDragCancel, onDragEnd, onDragStart };
}

describe("cancelTimelineInteractions", () => {
  beforeEach(() => {
    useInteractionStore.getState().stopDrag();
  });

  it("cancels a live drag and clears the preview state it drove", () => {
    const { onDragCancel, onDragEnd, onDragStart } = renderDraggable();

    fireEvent.pointerDown(screen.getByTestId("drag-handle"), {
      button: 0,
      isPrimary: true,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(document, { clientX: 24, clientY: 0 });
    expect(onDragStart).toHaveBeenCalledOnce();

    useInteractionStore.setState({
      activeId: "clip_1",
      operation: "move",
      snapPoints: [0, 240],
      projectedEndTime: 480,
      transformDropPreview: {
        kind: "gap",
        gapIndex: 1,
        compatible: true,
      },
    });

    act(() => {
      cancelTimelineInteractions();
    });

    expect(onDragCancel).toHaveBeenCalledOnce();
    // Cancelled, not dropped: an interrupted drag must not commit an edit.
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(useInteractionStore.getState()).toMatchObject({
      activeId: null,
      operation: null,
      snapPoints: [],
      projectedEndTime: null,
      transformDropPreview: null,
    });

    // The pointer stream is over: releasing where the timeline used to be
    // cannot resurrect the drag.
    fireEvent.pointerUp(document, { clientX: 24, clientY: 0 });
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is in flight", () => {
    const { onDragCancel } = renderDraggable();

    act(() => {
      cancelTimelineInteractions();
      cancelTimelineInteractions();
    });

    expect(onDragCancel).not.toHaveBeenCalled();
    expect(useInteractionStore.getState().activeId).toBeNull();
  });
});
