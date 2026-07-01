import { useEffect, useState, type ComponentType } from "react";
import type {
  ExtensionUiWorkspaceComponentProps,
  ExtensionUiWorkspaceLocation,
} from "../types";
import { extensionUiSlotRegistry } from "./ExtensionUiSlotRegistry";
import { ExtensionTrustedReactMount } from "./ExtensionTrustedReactMount";
import { useExtensionUiContributionRevision } from "./useExtensionWorkspaceRegion";

export interface ExtensionWorkspaceMountProps {
  readonly workspaceId: string;
  readonly location: ExtensionUiWorkspaceLocation;
  readonly active: boolean;
}

/** Lazily mounts a workspace, then keeps its React state alive between visits. */
export function ExtensionWorkspaceMount({
  workspaceId,
  location,
  active,
}: ExtensionWorkspaceMountProps) {
  useExtensionUiContributionRevision();
  const [hasBeenActive, setHasBeenActive] = useState(active);
  useEffect(() => {
    if (!active) return;
    // Preserve extension-local editor state after the first visit without
    // eagerly running every registered workspace at application startup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasBeenActive(true);
  }, [active]);
  const contribution = extensionUiSlotRegistry
    .listWorkspaces(location)
    .find((candidate) => candidate.id === workspaceId);
  if (!contribution || contribution.definition.kind !== "trusted-workspace") {
    return null;
  }
  if (!active && !hasBeenActive) return null;
  const component = contribution.definition.component as ComponentType<
    ExtensionUiWorkspaceComponentProps
  >;

  return (
    <ExtensionTrustedReactMount
      contributionId={contribution.id}
      surface="Extension workspace"
      report={contribution.definition.report}
      component={component}
      componentProps={{ workspaceId, location, active }}
    />
  );
}
