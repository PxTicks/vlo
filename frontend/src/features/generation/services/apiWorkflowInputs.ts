import type { WorkflowInput } from "../types";
import {
  INPUT_NODE_MAP,
  type InputNodeMap,
  resolveInputNodeMappings,
  type InputNodeMapEntry,
} from "../constants/inputNodeMap";
import { resolveNodeDisplayTitle } from "./nodeTitles";
import { buildWorkflowInputId } from "../utils/workflowInputs";
import { canonicalizeWorkflowClassType } from "../utils/workflowClassTypes";

function resolveWorkflowInputLabel(
  nodeTitle: string,
  mapping: InputNodeMapEntry,
  hasMultipleMappings: boolean,
): string {
  if (hasMultipleMappings) {
    return mapping.label ?? mapping.param;
  }
  return nodeTitle;
}

/**
 * Parse a ComfyUI API/prompt-shaped workflow (`class_type` + `inputs`) into
 * panel-discoverable inputs.
 *
 * This is intentionally separate from the live graph bridge. The active UI
 * synchronizes display state from `activeWorkflow.activeState`; this helper is
 * for callers that already have an API workflow from metadata, replay data, or
 * another non-live source.
 */
export function parseInputsFromApiWorkflow(
  workflow: Record<string, unknown>,
  inputNodeMap?: InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
): WorkflowInput[] {
  const nodeMap = inputNodeMap ?? INPUT_NODE_MAP;
  const inputs: WorkflowInput[] = [];

  for (const [nodeId, nodeData] of Object.entries(workflow)) {
    if (!nodeData || typeof nodeData !== "object") continue;

    const node = nodeData as Record<string, unknown>;
    if (node.mode === 2 || node.mode === 4) continue;
    const rawClassType = node.class_type as string | undefined;
    const classType = canonicalizeWorkflowClassType(rawClassType) ?? rawClassType;
    if (!classType) continue;

    const mappings = resolveInputNodeMappings(nodeMap, classType);
    if (mappings.length === 0) continue;

    const nodeInputs = (node.inputs ?? {}) as Record<string, unknown>;
    const meta = (node._meta ?? {}) as Record<string, unknown>;
    const nodeTitle =
      resolveNodeDisplayTitle({
        workflowTitle: meta.title,
        classType,
        objectInfo,
      }) ?? classType;
    const hasMultipleMappings = mappings.length > 1;

    for (const mapping of mappings) {
      inputs.push({
        id: buildWorkflowInputId(nodeId, mapping.param),
        nodeId,
        classType,
        inputType: mapping.inputType,
        param: mapping.param,
        label: resolveWorkflowInputLabel(nodeTitle, mapping, hasMultipleMappings),
        description: mapping.description ?? null,
        currentValue: nodeInputs[mapping.param] ?? null,
        origin: "inferred",
        dispatch: { kind: "node" },
      });
    }
  }

  return inputs;
}
