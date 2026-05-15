import { isRecord } from "../services/parsers";
import { canonicalizeWorkflowClassType } from "./workflowClassTypes";

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

    const normalizedNodeType =
      canonicalizeWorkflowClassType(nodeType) ?? nodeType.trim();
    const key = prefix ? `${prefix}${nodeId}` : String(nodeId);
    result.set(key, normalizedNodeType);
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

      result.set(
        String(nodeId),
        canonicalizeWorkflowClassType(nodeData.class_type) ??
          nodeData.class_type.trim(),
      );
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

function normalizeLinkedInput(
  value: unknown,
  knownNodeIds: ReadonlySet<string>,
): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const [sourceNodeId, outputIndex = 0] = value;
  if (
    typeof sourceNodeId !== "string" &&
    typeof sourceNodeId !== "number"
  ) {
    return null;
  }

  if (typeof outputIndex !== "number" && typeof outputIndex !== "string") {
    return null;
  }

  const normalizedNodeId = String(sourceNodeId);
  if (!knownNodeIds.has(normalizedNodeId)) {
    return null;
  }

  return `${normalizedNodeId}:${String(outputIndex)}`;
}

interface GraphLinkReference {
  sourceNodeId: string;
  outputIndex: number;
  targetNodeId: string;
}

function collectGraphLinkReferences(
  links: unknown,
): Map<number, GraphLinkReference> {
  const result = new Map<number, GraphLinkReference>();
  if (!Array.isArray(links)) {
    return result;
  }

  for (const link of links) {
    if (!Array.isArray(link) || link.length < 5) {
      continue;
    }

    const [linkId, sourceNodeId, outputIndex, targetNodeId] = link;
    if (
      typeof linkId !== "number" ||
      (typeof sourceNodeId !== "string" && typeof sourceNodeId !== "number") ||
      typeof outputIndex !== "number" ||
      (typeof targetNodeId !== "string" && typeof targetNodeId !== "number")
    ) {
      continue;
    }

    result.set(linkId, {
      sourceNodeId: String(sourceNodeId),
      outputIndex,
      targetNodeId: String(targetNodeId),
    });
  }

  return result;
}

function buildGraphWorkflowStructureSignature(
  workflowData: Record<string, unknown>,
): string | null {
  const nodes = Array.isArray(workflowData.nodes) ? workflowData.nodes : null;
  if (!nodes) {
    return null;
  }

  const knownNodeIds = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node) || node.id == null) {
      continue;
    }
    knownNodeIds.add(String(node.id));
  }

  const graphLinks = collectGraphLinkReferences(workflowData.links);
  const nodeEntries = nodes
    .map((node) => {
      if (!isRecord(node) || node.id == null || typeof node.type !== "string") {
        return null;
      }

      const nodeId = String(node.id);
      const nodeType =
        canonicalizeWorkflowClassType(node.type) ?? node.type.trim();
      if (!nodeType) {
        return null;
      }

      const inputs = Array.isArray(node.inputs) ? node.inputs : [];
      const linkedInputs = inputs
        .map((inputEntry, inputIndex) => {
          if (!isRecord(inputEntry) || typeof inputEntry.link !== "number") {
            return null;
          }

          const graphLink = graphLinks.get(inputEntry.link);
          if (!graphLink || !knownNodeIds.has(graphLink.sourceNodeId)) {
            return null;
          }

          const param =
            typeof inputEntry.name === "string" && inputEntry.name.trim() !== ""
              ? inputEntry.name.trim()
              : `input${inputIndex}`;
          return `${param}->${graphLink.sourceNodeId}:${graphLink.outputIndex}`;
        })
        .filter((entry): entry is string => entry !== null)
        .sort((left, right) => left.localeCompare(right));

      return {
        nodeId,
        signature: `${nodeId}:${nodeType}[${linkedInputs.join(",")}]`,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        nodeId: string;
        signature: string;
      } => entry !== null,
    )
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  if (nodeEntries.length === 0) {
    return null;
  }

  return nodeEntries.map((entry) => entry.signature).join("|");
}

export function buildWorkflowStructureSignature(
  workflowData: Record<string, unknown> | null | undefined,
): string | null {
  if (!workflowData) {
    return null;
  }

  if (!isApiWorkflow(workflowData)) {
    return buildGraphWorkflowStructureSignature(workflowData);
  }

  const knownNodeIds = new Set(Object.keys(workflowData));
  const nodeEntries = Object.entries(workflowData)
    .filter(([, nodeData]) => isRecord(nodeData))
    .map(([nodeId, nodeData]) => {
      const record = nodeData as Record<string, unknown>;
      const classType =
        typeof record.class_type === "string"
          ? (canonicalizeWorkflowClassType(record.class_type) ??
            record.class_type.trim())
          : null;
      if (!classType) {
        return null;
      }

      const inputs = isRecord(record.inputs) ? record.inputs : {};
      const linkedInputs = Object.entries(inputs)
        .map(([param, value]) => {
          const link = normalizeLinkedInput(value, knownNodeIds);
          return link ? `${param}->${link}` : null;
        })
        .filter((entry): entry is string => entry !== null)
        .sort((left, right) => left.localeCompare(right));

      return {
        nodeId,
        signature: `${nodeId}:${classType}[${linkedInputs.join(",")}]`,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        nodeId: string;
        signature: string;
      } => entry !== null,
    )
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  if (nodeEntries.length === 0) {
    return null;
  }

  return nodeEntries.map((entry) => entry.signature).join("|");
}

export function haveMatchingWorkflowNodes(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  const leftSignature = buildWorkflowNodeSignature(left);
  const rightSignature = buildWorkflowNodeSignature(right);
  return leftSignature !== null && leftSignature === rightSignature;
}
