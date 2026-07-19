import { useEffect } from "react";
import { useEditorFocusStore } from "../../editorFocus/useEditorFocusStore";
import { hostCommandTable } from "../../../core/shell/commandTable";
import { hostKeybindingRegistry } from "../../../core/shell/keybindingRegistry";

/**
 * Window-level dispatch for the command keybinding table. Listens in the
 * bubble phase and respects `defaultPrevented`, so the host's existing
 * component-level shortcuts always win over command bindings.
 */
export function useCommandKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      hostKeybindingRegistry.dispatch(
        event,
        useEditorFocusStore.getState().region,
        (commandId) =>
          hostCommandTable.executeCommand(commandId, {
            source: "keybinding",
          }),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
