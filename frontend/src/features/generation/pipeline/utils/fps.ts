/**
 * FPS and numeric resolution utilities for the generation pipeline.
 */

import type { WorkflowPostprocessingConfig } from "../../types";
import type { GeneratedCreationMetadata } from "../../../../types/Asset";
import type { TimelineSelection } from "../../../../types/TimelineTypes";
import { useProjectStore } from "../../../project";

export function toPositiveInteger(
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(1, Math.round(value));
}

export function toPositiveFps(
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Number(value.toFixed(3));
}

export function resolveSelectionMetadataFps(
  selection: TimelineSelection,
  fallbackFps: number,
): number {
  return toPositiveFps(selection.fps) ?? fallbackFps;
}

export async function resolvePostprocessStitchFps(
  metadata: GeneratedCreationMetadata,
  postprocessing: WorkflowPostprocessingConfig,
): Promise<number> {
  const overrideFps = toPositiveFps(postprocessing.stitch_fps);
  if (overrideFps !== null) return overrideFps;

  const projectFps = Math.max(1, useProjectStore.getState().config.fps);
  for (const input of metadata.inputs) {
    if (input.kind !== "timelineSelection") continue;
    const selectionFps = toPositiveFps(input.timelineSelection.fps);
    if (selectionFps !== null) return selectionFps;
  }

  const { getAssetById } = await import("../../../userAssets");
  for (const input of metadata.inputs) {
    if (input.kind !== "draggedAsset") continue;
    const parentAsset = getAssetById(input.parentAssetId);
    const assetFps = toPositiveFps(parentAsset?.fps);
    if (assetFps !== null) return assetFps;
  }

  return projectFps;
}
