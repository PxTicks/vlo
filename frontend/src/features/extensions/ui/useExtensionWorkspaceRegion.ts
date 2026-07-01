import { useCallback, useSyncExternalStore } from "react";
import type { ExtensionUiWorkspaceLocation } from "../types";
import { extensionUiSlotRegistry } from "./ExtensionUiSlotRegistry";

export interface ExtensionWorkspaceDescriptor {
  readonly id: string;
  readonly title: string;
  readonly location: ExtensionUiWorkspaceLocation;
}

export interface ExtensionWorkspaceRegionState {
  readonly workspaces: readonly ExtensionWorkspaceDescriptor[];
  readonly selectedWorkspaceId: string | null;
  selectWorkspace(workspaceId: string | null): void;
}

export function useExtensionUiContributionRevision(): void {
  useSyncExternalStore(
    (listener) => extensionUiSlotRegistry.subscribe(listener),
    () => extensionUiSlotRegistry.getRevision(),
    () => extensionUiSlotRegistry.getRevision(),
  );
}

/** Host-facing state for one curated workspace dock. */
export function useExtensionWorkspaceRegion(
  location: ExtensionUiWorkspaceLocation,
): ExtensionWorkspaceRegionState {
  useExtensionUiContributionRevision();
  const registered = extensionUiSlotRegistry.listWorkspaces(location);
  const workspaces = registered.flatMap((contribution) =>
    contribution.definition.kind === "trusted-workspace"
      ? [
          Object.freeze({
            id: contribution.id,
            title: contribution.definition.title,
            location: contribution.definition.location,
          }),
        ]
      : [],
  );
  const selectWorkspace = useCallback(
    (workspaceId: string | null) =>
      extensionUiSlotRegistry.selectWorkspace(location, workspaceId),
    [location],
  );

  return {
    workspaces,
    selectedWorkspaceId:
      extensionUiSlotRegistry.getSelectedWorkspaceId(location),
    selectWorkspace,
  };
}
