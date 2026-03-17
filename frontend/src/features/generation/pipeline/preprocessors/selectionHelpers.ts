/**
 * Shared helpers for normalizing timeline selections before rendering.
 *
 * Used by both video normalization and audio extraction preprocessors.
 */

import type { TimelineSelection } from "../../../../types/TimelineTypes";
import type { WorkflowManualSlotSelectionConfig } from "../../types";
import { toPositiveInteger } from "../utils/fps";

export function applySelectionConfigDefaults(
  selection: TimelineSelection,
  config: WorkflowManualSlotSelectionConfig | undefined,
): TimelineSelection {
  const next: TimelineSelection = { ...selection };
  const configFrameStep = toPositiveInteger(config?.frameStep);

  if (
    (typeof selection.frameStep !== "number" || selection.frameStep <= 1) &&
    configFrameStep !== null
  ) {
    next.frameStep = configFrameStep;
  }

  return next;
}

export function resolveExportFps(
  selection: TimelineSelection | null,
  _config: WorkflowManualSlotSelectionConfig | undefined,
  projectFps: number,
): number {
  const selectionFps = toPositiveInteger(selection?.fps);
  if (selectionFps !== null) return selectionFps;
  return projectFps;
}

export function resolveSelectionFpsForVideoSelection(
  selection: TimelineSelection,
  _config: WorkflowManualSlotSelectionConfig | undefined,
  projectFps: number,
): number {
  const selectionFps = toPositiveInteger(selection.fps);
  if (selectionFps !== null) return selectionFps;
  return projectFps;
}

export function prepareNormalizedSelection(
  selection: TimelineSelection,
  projectFps: number,
  config?: WorkflowManualSlotSelectionConfig,
): TimelineSelection {
  const normalizedSelection = applySelectionConfigDefaults(selection, config);
  if (
    typeof normalizedSelection.fps !== "number" ||
    normalizedSelection.fps <= 0
  ) {
    normalizedSelection.fps = resolveSelectionFpsForVideoSelection(
      normalizedSelection,
      config,
      projectFps,
    );
  }
  return normalizedSelection;
}
