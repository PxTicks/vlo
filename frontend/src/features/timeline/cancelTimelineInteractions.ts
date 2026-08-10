import { useInteractionStore } from "./hooks/useInteractionStore";

/**
 * Ends every pointer-driven timeline edit in flight
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §4.8).
 *
 * The shell calls this before it stops rendering the timeline surface, so a
 * clip drag, trim, or asset drop cannot survive the surface it was aimed at and
 * apply itself against a timeline the user can no longer see.
 *
 * Two things have to end, and only one of them is ours:
 *
 * 1. The dnd-kit drag the editor's `DndContext` is running. Its pointer sensors
 *    listen for `pointercancel` on the document — the same signal the browser
 *    itself sends when a pointer stream is interrupted — so dispatching one
 *    routes through the library's own cancel path and fires `onDragCancel`.
 *    The shell's region separators listen for it too, which is exactly the
 *    "cancel active layout drags" the plan asks for.
 * 2. The preview state this feature keeps for the drag (snap points, drop
 *    previews, projected duration), which the cancelled drag would normally
 *    clear on drop.
 *
 * Idempotent: with nothing in flight the dispatch has no listeners and the
 * store settles to the state it is already in.
 */
export function cancelTimelineInteractions(): void {
  if (typeof document !== "undefined") {
    document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
  }
  useInteractionStore.getState().stopDrag();
}
