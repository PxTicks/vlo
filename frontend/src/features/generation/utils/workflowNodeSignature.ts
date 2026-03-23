import { isRecord } from "../services/parsers";

function isApiWorkflow(
  workflowData: Record<string, unknown>,
): boolean {
  const entries = Object.values(workflowData).filter(isRecord);
  if (entries.length === 0) {
    return false;
  }

  return entries.every((node) => typeof node.class_type === "string");
}

function collectGraphNodes(
  nodes: unknown,
  result: Map<string, string>,
  prefix = "",
): void {
  if (!Array.isArray(nodes)) {
    return;
  }

  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }

    const nodeId = node.id;
    const nodeType = node.type;
    if (nodeId == null || typeof nodeType !== "string" || nodeType.trim() === "") {
      continue;
    }

    const key = prefix ? `${prefix}${nodeId}` : String(nodeId);
    result.set(key, nodeType.trim());
  }
}

export function extractWorkflowNodeMap(
  workflowData: Record<string, unknown> | null | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!workflowData) {
    return result;
  }

  if (isApiWorkflow(workflowData)) {
    for (const [nodeId, nodeData] of Object.entries(workflowData)) {
      if (!isRecord(nodeData) || typeof nodeData.class_type !== "string") {
        continue;
      }

      result.set(String(nodeId), nodeData.class_type.trim());
    }

    if (result.size > 0) {
      return result;
    }
  }

  collectGraphNodes(workflowData.nodes, result);

  const definitions = isRecord(workflowData.definitions)
    ? workflowData.definitions
    : null;
  const subgraphs = Array.isArray(definitions?.subgraphs)
    ? definitions.subgraphs
    : [];
  const subgraphsById = new Map<string, Record<string, unknown>>();

  for (const subgraph of subgraphs) {
    if (!isRecord(subgraph) || typeof subgraph.id !== "string") {
      continue;
    }
    subgraphsById.set(subgraph.id, subgraph);
  }

  if (!Array.isArray(workflowData.nodes) || subgraphsById.size === 0) {
    return result;
  }

  for (const node of workflowData.nodes) {
    if (!isRecord(node)) {
      continue;
    }

    if (node.id == null || typeof node.type !== "string") {
      continue;
    }

    const subgraph = subgraphsById.get(node.type);
    if (!subgraph) {
      continue;
    }

    collectGraphNodes(subgraph.nodes, result, `${node.id}:`);
  }

  return result;
}

export function buildWorkflowNodeSignature(
  workflowData: Record<string, unknown> | null | undefined,
): string | null {
  const nodeMap = extractWorkflowNodeMap(workflowData);
  if (nodeMap.size === 0) {
    return null;
  }

  return [...nodeMap.entries()]
    .sort(([leftId, leftType], [rightId, rightType]) => {
      if (leftId === rightId) {
        return leftType.localeCompare(rightType);
      }
      return leftId.localeCompare(rightId);
    })
    .map(([nodeId, classType]) => `${nodeId}:${classType}`)
    .join("|");
}

export function haveMatchingWorkflowNodes(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  const leftSignature = buildWorkflowNodeSignature(left);
  const rightSignature = buildWorkflowNodeSignature(right);
  return leftSignature !== null && leftSignature === rightSignature;
}
