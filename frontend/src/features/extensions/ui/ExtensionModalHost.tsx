import { useSyncExternalStore, type ComponentType } from "react";
import { Dialog, DialogContent, DialogTitle } from "@mui/material";
import type { ExtensionUiModalComponentProps } from "../types";
import { extensionUiSlotRegistry } from "./ExtensionUiSlotRegistry";
import { ExtensionTrustedReactMount } from "./ExtensionTrustedReactMount";

const MAX_WIDTH = {
  small: "sm",
  medium: "md",
  large: "lg",
} as const;

export function ExtensionModalHost() {
  useSyncExternalStore(
    (listener) => extensionUiSlotRegistry.subscribe(listener),
    () => extensionUiSlotRegistry.getRevision(),
    () => extensionUiSlotRegistry.getRevision(),
  );
  const active = extensionUiSlotRegistry.getActiveModal();
  if (!active || active.contribution.definition.kind !== "trusted-modal") {
    return null;
  }
  const definition = active.contribution.definition;
  const component = definition.component as ComponentType<
    ExtensionUiModalComponentProps
  >;

  return (
    <Dialog
      open
      fullWidth
      maxWidth={MAX_WIDTH[definition.size]}
      onClose={() => extensionUiSlotRegistry.closeActiveModal()}
      aria-labelledby="extension-modal-title"
    >
      <DialogTitle id="extension-modal-title">{definition.title}</DialogTitle>
      <DialogContent dividers>
        <ExtensionTrustedReactMount
          contributionId={active.contribution.id}
          surface="Extension modal"
          report={definition.report}
          component={component}
          componentProps={{
            input: active.input,
            close: (result) =>
              extensionUiSlotRegistry.closeActiveModal(result),
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
