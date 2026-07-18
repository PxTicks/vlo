import { useEffect } from "react";
import { useEditorFocusStore } from "../../editorFocus/useEditorFocusStore";
import { hostCommandRegistry } from "./CommandRegistry";
import { hostKeybindingRegistry } from "./KeybindingRegistry";

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
          hostCommandRegistry.executeCommand(commandId, {
            source: "keybinding",
          }),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
