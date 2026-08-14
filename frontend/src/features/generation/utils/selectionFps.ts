/**
 * Frame-rate resolution for workflow timeline selections.
 *
 * A rule's `selection.export_fps` either pins a number (`24`) or links the
 * selection to the open project's frame rate (`"project"`). The link exists so
 * model-agnostic workflows stay in step with the timeline instead of baking a
 * rate into the rules that silently disagrees with it.
 */

import type { WorkflowSelectionConfig } from "../types";

export const PROJECT_SELECTION_FPS = "project";

/**
 * The selection fps a rule asks for, or `null` when it expresses no
 * preference — callers then fall back to whatever default fits their context.
 */
export function resolveSelectionConfigFps(
  config: WorkflowSelectionConfig | undefined,
  projectFps: number,
): number | null {
  const exportFps = config?.exportFps;
  if (exportFps === PROJECT_SELECTION_FPS) {
    return Number.isFinite(projectFps) && projectFps > 0 ? projectFps : null;
  }
  return typeof exportFps === "number" &&
    Number.isFinite(exportFps) &&
    exportFps > 0
    ? exportFps
    : null;
}
