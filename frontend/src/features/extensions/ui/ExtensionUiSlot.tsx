import { useSyncExternalStore, type ComponentType } from "react";
import { Alert, AlertTitle, Box } from "@mui/material";
import type {
  ExtensionUiComponentProps,
  ExtensionUiSlotId,
} from "../types";
import {
  extensionUiSlotRegistry,
  type RegisteredExtensionUiContribution,
} from "./ExtensionUiSlotRegistry";
import { ExtensionTrustedReactMount } from "./ExtensionTrustedReactMount";

export interface ExtensionUiSlotProps {
  readonly slot: ExtensionUiSlotId;
  readonly presentation?: "stack" | "inline";
}

function TrustedExtensionComponent({
  contribution,
}: {
  readonly contribution: RegisteredExtensionUiContribution;
}) {
  if (contribution.definition.kind !== "trusted-react") return null;
  const component = contribution.definition.component as ComponentType<
    ExtensionUiComponentProps
  >;
  return (
    <ExtensionTrustedReactMount
      contributionId={contribution.id}
      surface="UI contribution"
      report={contribution.definition.report}
      component={component}
      componentProps={{ slot: contribution.definition.slot }}
    />
  );
}

export function ExtensionUiSlot({
  slot,
  presentation = "stack",
}: ExtensionUiSlotProps) {
  useSyncExternalStore(
    (listener) => extensionUiSlotRegistry.subscribe(listener),
    () => extensionUiSlotRegistry.getRevision(),
    () => extensionUiSlotRegistry.getRevision(),
  );
  const contributions = extensionUiSlotRegistry.list(slot);
  if (contributions.length === 0) return null;

  return (
    <Box
      data-testid={`extension-ui-slot-${slot}`}
      sx={
        presentation === "inline"
          ? { display: "flex", alignItems: "center", gap: 1 }
          : { px: 1, pt: 1 }
      }
    >
      {contributions.map((contribution) =>
        contribution.definition.kind === "notice" ? (
          <Alert
            key={contribution.id}
            data-testid={`extension-ui-contribution-${contribution.id}`}
            severity={contribution.definition.tone}
            sx={presentation === "stack" ? { mb: 1 } : undefined}
          >
            <AlertTitle>{contribution.definition.title}</AlertTitle>
            {contribution.definition.message}
          </Alert>
        ) : contribution.definition.kind === "trusted-react" ? (
          <Box
            key={contribution.id}
            data-testid={`extension-ui-contribution-${contribution.id}`}
            sx={presentation === "stack" ? { mb: 1 } : undefined}
          >
            <TrustedExtensionComponent contribution={contribution} />
          </Box>
        ) : null,
      )}
    </Box>
  );
}
