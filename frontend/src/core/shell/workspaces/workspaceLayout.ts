import {
  DOCK_REGIONS,
  type DockRegion,
  type EditorStageSurfaces,
  type PersistedPanelPlacement,
  type ShellLayoutDocumentV2,
  type ShellPanelDescriptor,
  type WorkspaceLayoutOverride,
} from "../layout/layoutTypes";
import type {
  WorkspaceComposition,
  WorkspaceDockSlot,
} from "./workspaceTypes";

function mergeWorkspaceOverride(
  base: ShellLayoutDocumentV2,
  override: WorkspaceLayoutOverride | undefined,
): ShellLayoutDocumentV2 {
  if (!override) return base;
  const panels = { ...base.panels };
  for (const [viewId, placement] of Object.entries(override.panels)) {
    panels[viewId] = { ...panels[viewId], ...placement };
  }
  const regions = { ...base.regions };
  for (const [region, state] of Object.entries(override.regions)) {
    regions[region as DockRegion] = {
      ...regions[region as DockRegion],
      ...state,
    };
  }
  return {
    ...base,
    panels,
    regions,
    ...(override.lowerStage === undefined
      ? {}
      : { lowerStage: { ...base.lowerStage, ...override.lowerStage } }),
  };
}

function effectiveRegion(
  descriptor: ShellPanelDescriptor,
  placement: PersistedPanelPlacement | undefined,
): DockRegion {
  const requested = placement?.region;
  return requested !== undefined && descriptor.allowedRegions.includes(requested)
    ? requested
    : descriptor.defaultRegion;
}

function listedIds(slot: WorkspaceDockSlot | undefined): readonly string[] {
  return slot?.mode === "augment" || slot?.mode === "replace"
    ? slot.panels.map((panel) => panel.viewId)
    : [];
}

/**
 * Applies saved workspace intent and the feature's live composition without
 * mutating the user's everyday document. The returned document is session-only.
 */
export function createWorkspaceLayoutDocument(input: {
  readonly base: ShellLayoutDocumentV2;
  readonly override?: WorkspaceLayoutOverride;
  readonly composition: WorkspaceComposition;
  readonly panels: readonly ShellPanelDescriptor[];
}): ShellLayoutDocumentV2 {
  const layered = input.base;
  const panels: Record<string, PersistedPanelPlacement> = {
    ...layered.panels,
  };
  const regions = { ...layered.regions };

  // Placement is composed across all docks first. This makes replace-mode
  // hiding independent of object iteration order when a panel moves between
  // two regions in the same transaction.
  for (const region of DOCK_REGIONS) {
    const slot = input.composition.docks?.[region];
    if (!slot || slot.mode === "inherit") continue;
    slot.panels.forEach((panel, order) => {
      const descriptor = input.panels.find(
        (candidate) => candidate.id === panel.viewId,
      );
      if (!descriptor?.allowedRegions.includes(region)) return;
      panels[panel.viewId] = {
        ...panels[panel.viewId],
        region,
        visible: true,
        order,
      };
    });
  }

  for (const region of DOCK_REGIONS) {
    const slot = input.composition.docks?.[region];
    if (!slot || slot.mode === "inherit") continue;
    const included = new Set(listedIds(slot));
    if (slot.mode === "replace") {
      for (const descriptor of input.panels) {
        if (
          effectiveRegion(descriptor, panels[descriptor.id]) === region &&
          !included.has(descriptor.id)
        ) {
          panels[descriptor.id] = {
            ...panels[descriptor.id],
            visible: false,
          };
        }
      }
    }

    const selectedViewId =
      slot.selectedViewId === undefined
        ? (slot.panels[0]?.viewId ?? null)
        : slot.selectedViewId;
    regions[region] = {
      ...regions[region],
      selectedViewId,
      ...(slot.panels.length > 0 ? { collapsed: false } : {}),
    };
  }

  const composed = {
    ...layered,
    panels,
    regions,
  };
  // The definition supplies the workspace's safe starting arrangement. A
  // layout the user explicitly saved for this workspace is their customization
  // of that arrangement and therefore wins on the fields it records.
  const customized = mergeWorkspaceOverride(composed, input.override);
  const customizedPanels = { ...customized.panels };
  for (const slot of Object.values(input.composition.docks ?? {})) {
    if (!slot || slot.mode === "inherit") continue;
    for (const panel of slot.panels) {
      if (!panel.required) continue;
      customizedPanels[panel.viewId] = {
        ...customizedPanels[panel.viewId],
        visible: true,
      };
    }
  }
  return { ...customized, panels: customizedPanels };
}

export function getWorkspaceStageSurfaces(
  composition: WorkspaceComposition,
): EditorStageSurfaces {
  const stageSurfaces: Record<string, string> = {};
  for (const [stage, slot] of Object.entries(composition.stages ?? {})) {
    if (slot) stageSurfaces[stage] = slot.surfaceId;
  }
  return stageSurfaces;
}

export function captureWorkspaceLayoutOverride(
  document: ShellLayoutDocumentV2,
): WorkspaceLayoutOverride {
  return {
    panels: { ...document.panels },
    regions: { ...document.regions },
    ...(document.lowerStage === undefined
      ? {}
      : { lowerStage: { ...document.lowerStage } }),
  };
}
