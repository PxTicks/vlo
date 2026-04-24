import type { WorkflowRules } from "./types";

type WorkflowPipelineStage = NonNullable<WorkflowRules["pipeline"]>[number];
export type WorkflowPipelineStageKind = Exclude<
  WorkflowPipelineStage["kind"],
  undefined
>;

export interface WorkflowPipelineStageCapability {
  affectsPreparedAssets: boolean;
}

export const WORKFLOW_PIPELINE_STAGE_CAPABILITIES = {
  mask_processing: {
    affectsPreparedAssets: true,
  },
  aspect_ratio: {
    affectsPreparedAssets: true,
  },
  output_assembly: {
    affectsPreparedAssets: false,
  },
} satisfies Record<WorkflowPipelineStageKind, WorkflowPipelineStageCapability>;

export function isWorkflowPipelineStageKind(
  value: unknown,
): value is WorkflowPipelineStageKind {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      WORKFLOW_PIPELINE_STAGE_CAPABILITIES,
      value,
    )
  );
}

export function workflowPipelineStageAffectsPreparedAssets(
  kind: unknown,
): boolean {
  return (
    isWorkflowPipelineStageKind(kind) &&
    WORKFLOW_PIPELINE_STAGE_CAPABILITIES[kind].affectsPreparedAssets
  );
}
