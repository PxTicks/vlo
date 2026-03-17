// hooks/dnd/strategies/selectionLogic.ts (New File)

type SelectionAction =
  | { type: "SELECT_SINGLE"; id: string }
  | { type: "TOGGLE"; id: string }
  | { type: "NONE" };

export const getDragStartSelectionAction = (
  clipId: string,
  isSelected: boolean,
  isMulti: boolean
): SelectionAction => {
  // Rule 1: If not selected, we must select it immediately
  // (Otherwise we'd be dragging something we don't 'hold')
  if (!isSelected) {
    return isMulti
      ? { type: "TOGGLE", id: clipId } // Add to group
      : { type: "SELECT_SINGLE", id: clipId }; // Switch to this
  }

  // Rule 2: If already selected...
  if (isSelected) {
    if (isMulti) {
      // Ctrl+Click on selected = Deselect (Toggle)
      return { type: "TOGGLE", id: clipId };
    }
    // Rule 3: Click on selected (No modifier)
    // Do NOTHING yet. We wait to see if it's a drag or a click.
    return { type: "NONE" };
  }

  return { type: "NONE" };
};

/**
 */
export const getDragEndClickAction = (
  clipId: string,
  wasDrag: boolean,
  isMulti: boolean,
  isSelected: boolean // passed for safety, though usually true here
): SelectionAction => {
  // If we dragged, the selection is already settled. Do nothing.
  if (wasDrag) return { type: "NONE" };

  if (!isMulti && isSelected) {
    // Then the user meant "Select ONLY this one" (clear the others)
    return { type: "SELECT_SINGLE", id: clipId };
  }

  return { type: "NONE" };
};
