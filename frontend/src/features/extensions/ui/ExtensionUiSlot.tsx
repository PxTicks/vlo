import {
  Component,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Alert, AlertTitle, Box } from "@mui/material";
import type { ExtensionUiSlotId } from "../types";
import {
  extensionUiSlotRegistry,
  type RegisteredExtensionUiContribution,
} from "./ExtensionUiSlotRegistry";

interface ExtensionUiContributionBoundaryProps {
  contribution: RegisteredExtensionUiContribution;
  children: ReactNode;
}

interface ExtensionUiContributionBoundaryState {
  failed: boolean;
}

class ExtensionUiContributionBoundary extends Component<
  ExtensionUiContributionBoundaryProps,
  ExtensionUiContributionBoundaryState
> {
  state: ExtensionUiContributionBoundaryState = { failed: false };

  static getDerivedStateFromError(): ExtensionUiContributionBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.contribution.definition.report(
      "error",
      `UI contribution '${this.props.contribution.id}' failed to render.`,
      { error, componentStack: info.componentStack },
    );
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface ExtensionUiSlotProps {
  slot: ExtensionUiSlotId;
}

interface TrustedExtensionComponentProps {
  contribution: RegisteredExtensionUiContribution;
}

function TrustedExtensionComponent({
  contribution,
}: TrustedExtensionComponentProps) {
  if (contribution.definition.kind !== "trusted-react") return null;
  const Component = contribution.definition.component as () => ReactNode;
  return <Component />;
}

export function ExtensionUiSlot({ slot }: ExtensionUiSlotProps) {
  useSyncExternalStore(
    (listener) => extensionUiSlotRegistry.subscribe(listener),
    () => extensionUiSlotRegistry.getRevision(),
    () => extensionUiSlotRegistry.getRevision(),
  );
  const contributions = extensionUiSlotRegistry.list(slot);
  if (contributions.length === 0) return null;

  return (
    <Box data-testid={`extension-ui-slot-${slot}`} sx={{ px: 1, pt: 1 }}>
      {contributions.map((contribution) => (
        <ExtensionUiContributionBoundary
          key={contribution.id}
          contribution={contribution}
        >
          {contribution.definition.kind === "notice" ? (
            <Alert
              data-testid={`extension-ui-contribution-${contribution.id}`}
              severity={contribution.definition.tone}
              sx={{ mb: 1 }}
            >
              <AlertTitle>{contribution.definition.title}</AlertTitle>
              {contribution.definition.message}
            </Alert>
          ) : (
            <Box
              data-testid={`extension-ui-contribution-${contribution.id}`}
              sx={{ mb: 1 }}
            >
              <TrustedExtensionComponent contribution={contribution} />
            </Box>
          )}
        </ExtensionUiContributionBoundary>
      ))}
    </Box>
  );
}
