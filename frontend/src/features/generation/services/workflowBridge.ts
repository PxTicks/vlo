import type { WorkflowInput } from "../types";
import {
  INPUT_NODE_MAP,
  type InputNodeMap,
  resolveInputNodeMappings,
  type InputNodeMapEntry,
} from "../constants/inputNodeMap";
import { isRecord } from "./parsers";
import {
  resolveClassInfo,
  resolveNodeDisplayTitle,
} from "./nodeTitles";
import { buildWorkflowInputId } from "../utils/workflowInputs";
import { canonicalizeWorkflowClassType } from "../utils/workflowClassTypes";

/**
 * Pure graph-parsing helpers for ComfyUI visual workflows.
 *
 * This module no longer touches the iframe: all iframe interaction
 * (inject/read/warnings/resolve) goes through vlo's hosted bridge via
 * `iframeBridgeClient.ts`. What remains here is the LiteGraph-JSON → panel
 * inputs projection.
 */

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

function resolveInputSpec(
  classInfo: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return isRecord(classInfo?.input) ? classInfo.input : null;
}

function resolveParamDefinition(
  inputSpec: Record<string, unknown> | null,
  param: string,
): [unknown, Record<string, unknown>] | null {
  if (!inputSpec) return null;

  for (const sectionKey of ["required", "optional"] as const) {
    const section = inputSpec[sectionKey];
    if (!isRecord(section)) continue;
    const definition = section[param];
    if (!Array.isArray(definition) || definition.length === 0) continue;
    return [definition[0], isRecord(definition[1]) ? definition[1] : {}];
  }

  return null;
}

function getOrderedObjectInfoParams(
  inputSpec: Record<string, unknown> | null,
  classInfo: Record<string, unknown> | null,
): string[] {
  const ordered = new Set<string>();
  if (!inputSpec) return [];

  const rawOrder = classInfo?.input_order;
  if (isRecord(rawOrder)) {
    for (const sectionKey of ["required", "optional"] as const) {
      const sectionOrder = rawOrder[sectionKey];
      if (!Array.isArray(sectionOrder)) continue;
      for (const param of sectionOrder) {
        if (typeof param === "string" && param.trim().length > 0) {
          ordered.add(param);
        }
      }
    }
  }

  for (const sectionKey of ["required", "optional"] as const) {
    const section = inputSpec[sectionKey];
    if (!isRecord(section)) continue;
    for (const param of Object.keys(section)) {
      ordered.add(param);
    }
  }

  return [...ordered];
}

function getWidgetValueTypeFromTypeSpec(
  typeSpec: unknown,
  opts: Record<string, unknown>,
): "widget" | "non_widget" {
  if (typeof typeSpec === "string") {
    const normalized = typeSpec.trim().toUpperCase();
    if (
      normalized === "INT" ||
      normalized === "FLOAT" ||
      normalized === "STRING" ||
      normalized === "BOOLEAN"
    ) {
      return "widget";
    }
    if (normalized === "COMBO" && Array.isArray(opts.options)) {
      return "widget";
    }
    return "non_widget";
  }

  if (Array.isArray(typeSpec)) {
    return "widget";
  }

  return "non_widget";
}

function getWidgetValueIndexMap(
  classInfo: Record<string, unknown> | null,
): Map<string, number> {
  const inputSpec = resolveInputSpec(classInfo);
  const orderedParams = getOrderedObjectInfoParams(inputSpec, classInfo);
  const result = new Map<string, number>();

  let index = 0;
  for (const param of orderedParams) {
    const definition = resolveParamDefinition(inputSpec, param);
    if (!definition) continue;

    const [typeSpec, opts] = definition;
    if (getWidgetValueTypeFromTypeSpec(typeSpec, opts) !== "widget") {
      continue;
    }

    result.set(param, index);
    index += opts.control_after_generate === true ? 2 : 1;
  }

  return result;
}

/** Context for resolving an inner node's links against the subgraph boundary:
 * which internal link ids come from the definition's input slots, and which of
 * those slots the enclosing instance node actually has wired externally. */
interface SubgraphBoundary {
  inputNamesByLinkId: Map<number, string>;
  externallyLinkedInputNames: Set<string>;
}

function collectLinkedInputNames(
  node: Record<string, unknown>,
  boundary: SubgraphBoundary | null = null,
): Set<string> {
  const linked = new Set<string>();
  const rawInputs = Array.isArray(node.inputs) ? node.inputs : [];
  for (const entry of rawInputs) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    if (typeof entry.link !== "number") continue;
    if (boundary) {
      const slotName = boundary.inputNamesByLinkId.get(entry.link);
      if (
        slotName !== undefined &&
        !boundary.externallyLinkedInputNames.has(slotName)
      ) {
        // Promoted widget whose outer slot is unconnected: the inner
        // node's own widget value is what executes.
        continue;
      }
    }
    linked.add(entry.name);
  }
  return linked;
}

/** Index subgraph definitions by id, including definitions nested inside
 * other definitions. Instance nodes reference them via `node.type`. */
function collectSubgraphDefinitions(
  graphData: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const pending: Record<string, unknown>[] = [graphData];
  while (pending.length > 0) {
    const definitions = pending.pop()?.definitions;
    if (!isRecord(definitions)) continue;
    const subgraphs = Array.isArray(definitions.subgraphs)
      ? definitions.subgraphs
      : [];
    for (const subgraph of subgraphs) {
      if (!isRecord(subgraph) || typeof subgraph.id !== "string") continue;
      if (byId.has(subgraph.id)) continue;
      byId.set(subgraph.id, subgraph);
      pending.push(subgraph);
    }
  }
  return byId;
}

function buildSubgraphBoundary(
  definition: Record<string, unknown>,
  instanceNode: Record<string, unknown>,
): SubgraphBoundary {
  const inputNamesByLinkId = new Map<number, string>();
  const definitionInputs = Array.isArray(definition.inputs)
    ? definition.inputs
    : [];
  for (const entry of definitionInputs) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const linkIds = Array.isArray(entry.linkIds) ? entry.linkIds : [];
    for (const linkId of linkIds) {
      if (typeof linkId === "number") inputNamesByLinkId.set(linkId, entry.name);
    }
  }
  return {
    inputNamesByLinkId,
    externallyLinkedInputNames: collectLinkedInputNames(instanceNode),
  };
}

function sortNodesByNumericId(rawNodes: unknown[]): unknown[] {
  // Iterate in numeric-id order so input ordering does not depend on the
  // author's visual node placement. Pre-`df8ea99` the workflow was projected
  // through an API-shape object keyed by node-id strings, which JS iterates
  // numerically — code downstream (group ordering, sortConditioningInputs)
  // implicitly relies on that.
  return [...rawNodes].sort((left, right) => {
    if (!isRecord(left) || !isRecord(right)) return 0;
    const leftId = String(left.id ?? "");
    const rightId = String(right.id ?? "");
    const leftNum = /^-?\d+$/.test(leftId) ? Number.parseInt(leftId, 10) : NaN;
    const rightNum = /^-?\d+$/.test(rightId) ? Number.parseInt(rightId, 10) : NaN;
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
      return leftNum - rightNum;
    }
    if (Number.isFinite(leftNum)) return -1;
    if (Number.isFinite(rightNum)) return 1;
    return leftId.localeCompare(rightId);
  });
}

/**
 * Discover panel input nodes directly from a ComfyUI visual workflow graph.
 *
 * This walks the LiteGraph `nodes[]` array — class_type comes from
 * `node.type`, the panel title from `node.title`, and the current widget
 * value from `widgets_values` resolved via the object_info widget index map
 * for the class. No API-shape projection happens; this is the cheap "I have
 * a visual graph, populate the panel" path.
 *
 * Nodes inside subgraph definitions are discovered too, scoped by their
 * instance path (`<instanceId>:<innerId>`, nested as `<a>:<b>:<c>`) — the
 * same ids ComfyUI's graphToPrompt gives them in the flattened prompt, and
 * the same convention the backend's workflow-rules discovery uses
 * (`services/workflow_rules/object_info.py`).
 *
 * NOTE: This is for input discovery only. It is NEVER a substitute for
 * `graphToPrompt` and MUST NEVER be the source of an execution payload — see
 * `captureSubmittedWorkflow` in `executionStoreState.ts`, which resolves the
 * submission payload through the hosted vlo bridge.
 */
export function parseInputsFromGraphData(
  graphData: Record<string, unknown>,
  options: {
    inputNodeMap?: InputNodeMap | null;
    objectInfo?: Record<string, unknown> | null;
  } = {},
): WorkflowInput[] {
  const nodeMap = options.inputNodeMap ?? INPUT_NODE_MAP;
  const objectInfo = options.objectInfo ?? null;
  const subgraphsById = collectSubgraphDefinitions(graphData);
  const inputs: WorkflowInput[] = [];

  const appendInputsFromNodes = (
    rawNodes: unknown[],
    idPrefix: string,
    boundary: SubgraphBoundary | null,
    activeDefinitionIds: ReadonlySet<string>,
  ): void => {
    for (const node of sortNodesByNumericId(rawNodes)) {
      if (!isRecord(node) || node.id == null || typeof node.type !== "string") {
        continue;
      }
      if (node.mode === 2 || node.mode === 4) continue;
      const rawClassType = node.type.trim();
      const classType =
        canonicalizeWorkflowClassType(rawClassType) ?? rawClassType;
      if (!classType) continue;

      const nodeId = `${idPrefix}${node.id}`;

      const definition = subgraphsById.get(rawClassType);
      if (definition) {
        // A subgraph instance: expand its definition in place. The id-set
        // guards against (malformed) self-referential definitions.
        if (activeDefinitionIds.has(rawClassType)) continue;
        const definitionNodes = Array.isArray(definition.nodes)
          ? definition.nodes
          : [];
        appendInputsFromNodes(
          definitionNodes,
          `${nodeId}:`,
          buildSubgraphBoundary(definition, node),
          new Set(activeDefinitionIds).add(rawClassType),
        );
        continue;
      }

      const mappings = resolveInputNodeMappings(nodeMap, classType);
      if (mappings.length === 0) continue;

      const nodeTitle =
        resolveNodeDisplayTitle({
          graphTitle: node.title,
          classType,
          objectInfo,
          fallback: `Node ${nodeId}`,
        }) ?? `Node ${nodeId}`;
      const hasMultipleMappings = mappings.length > 1;

      const widgetsValues = Array.isArray(node.widgets_values)
        ? node.widgets_values
        : [];
      const classInfo = resolveClassInfo(objectInfo, classType);
      const widgetIndexMap = getWidgetValueIndexMap(classInfo);
      const linkedParams = collectLinkedInputNames(node, boundary);

      for (const mapping of mappings) {
        let currentValue: unknown = null;
        if (!linkedParams.has(mapping.param)) {
          const widgetIndex = widgetIndexMap.get(mapping.param);
          if (widgetIndex !== undefined && widgetIndex < widgetsValues.length) {
            currentValue = widgetsValues[widgetIndex];
          } else if (mappings.length === 1 && widgetsValues.length > 0) {
            // Fallback for classes whose object_info we don't have:
            // single-mapping nodes like LoadImage put the path at slot 0.
            currentValue = widgetsValues[0];
          }
        }

        inputs.push({
          id: buildWorkflowInputId(nodeId, mapping.param),
          nodeId,
          classType,
          inputType: mapping.inputType,
          param: mapping.param,
          label: resolveWorkflowInputLabel(nodeTitle, mapping, hasMultipleMappings),
          description: mapping.description ?? null,
          currentValue,
          origin: "inferred",
          dispatch: { kind: "node" },
        });
      }
    }
  };

  const rawNodes = Array.isArray(graphData.nodes) ? graphData.nodes : [];
  appendInputsFromNodes(rawNodes, "", null, new Set());

  return inputs;
}

export interface WorkflowWarningSummary {
  missingNodeTypes: string[];
  missingModels: string[];
}

export interface WorkflowReadResult {
  // Graph-sync helpers always leave this as `null`; the submission payload
  // is resolved separately via the hosted bridge's `resolve-prompt` request.
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown>;
  inputs: WorkflowInput[];
  filename: string | null;
  workflowInstanceId: string | null;
  revision: number | null;
}

export function buildWorkflowResultFromGraphData(
  graphData: Record<string, unknown>,
  filename: string | null,
  options: {
    inputNodeMap?: InputNodeMap | null;
    objectInfo?: Record<string, unknown> | null;
    workflowInstanceId?: string | null;
    revision?: number | null;
  } = {},
): WorkflowReadResult {
  return {
    workflow: null,
    graphData,
    inputs: parseInputsFromGraphData(graphData, options),
    filename,
    workflowInstanceId: options.workflowInstanceId ?? null,
    revision: options.revision ?? null,
  };
}
