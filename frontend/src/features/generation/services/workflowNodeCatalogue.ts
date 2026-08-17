import { serializeFiniteJson } from "../utils/finiteJson";
import { buildFlatGraphNodeIndex, type FlatGraphNode } from "./graphSubgraphs";
import { resolveClassInfo, resolveNodeDisplayTitle } from "./nodeTitles";
import {
  getOrderedObjectInfoParams,
  getWidgetValueTypeFromTypeSpec,
  hasControlAfterGenerate,
  coerceWidgetOptions,
  inferWidgetValueType,
  isLinkValue,
  resolveGraphWidgetValue,
  resolveInputSpec,
  resolveParamDefinition,
} from "./objectInfoWidgets";
import { isRecord } from "./parsers";
import type {
  GenerationNodeSnapshot,
  GenerationSessionJsonValue,
  GenerationWidgetSnapshot,
} from "./generationSessionTypes";

/**
 * The session's node/widget catalogue
 * (docs/generation-native-extension-seams-plan.md §3.1).
 *
 * This is discovery, not policy: every node the submitted prompt would contain
 * is listed with every widget-backed parameter its class declares, whether or
 * not the panel surfaces a control for it. Subgraph instances are expanded the
 * way `graphToPrompt` expands them, so widgets inside a subgraph appear under
 * the scoped `<instanceId>:<innerId>` ids the prompt and the graph bridge use.
 *
 * Deliberately absent: node inputs, ports, links (beyond a per-widget `linked`
 * flag), raw LiteGraph objects, and editable topology. Adding any of those
 * needs its own native consumer and a bounded representation.
 */

/**
 * Structural fingerprint of a catalogue: node ids, class types, modes, and
 * widget names. Deliberately value-free, so it identifies *which workflow is
 * mounted* and does not churn as widget values change.
 */
export function computeGenerationCatalogueFingerprint(
  nodes: readonly GenerationNodeSnapshot[],
): string {
  // FNV-1a over the compact structural form: cheap, stable, and enough to
  // separate one mounted workflow from another.
  let hash = 0x811c9dc5;
  const append = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  // Escaped delimiters, not literal control bytes: they keep field boundaries
  // unambiguous without making this file read as binary data to git and grep.
  for (const node of nodes) {
    append(`${node.id}\u0001${node.classType}\u0001${node.mode}`);
    for (const widget of node.widgets) {
      append(`\u0002${widget.param}`);
    }
    append("\u0003");
  }
  return `${nodes.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/** Coerce to a value the session contract can carry, or `null`. */
function toJsonValue(value: unknown): GenerationSessionJsonValue | null {
  if (value === undefined) return null;
  const serialized = serializeFiniteJson(value);
  return serialized === null
    ? null
    : (JSON.parse(serialized) as GenerationSessionJsonValue);
}

function freezeOptions(
  options: Array<string | number | boolean> | undefined,
): readonly (string | number | boolean)[] | null {
  return options ? Object.freeze([...options]) : null;
}

function resolveNodeMode(
  nodeData: Record<string, unknown>,
  graphNode: FlatGraphNode | null,
): number {
  const graphMode = graphNode?.node.mode;
  if (typeof graphMode === "number") return graphMode;
  return typeof nodeData.mode === "number" ? nodeData.mode : 0;
}

function buildWidgetSnapshot(args: {
  nodeId: string;
  param: string;
  definition: [unknown, Record<string, unknown>] | null;
  nodeInputs: Record<string, unknown>;
  graphNode: FlatGraphNode | null;
  classInfo: Record<string, unknown> | null;
}): GenerationWidgetSnapshot | null {
  const { nodeId, param, definition, nodeInputs, graphNode, classInfo } = args;
  const typeSpec = definition?.[0];
  const opts = definition?.[1] ?? {};

  const hasPromptValue = Object.prototype.hasOwnProperty.call(
    nodeInputs,
    param,
  );
  const promptValue = hasPromptValue ? nodeInputs[param] : undefined;
  const graphValue = resolveGraphWidgetValue(graphNode, param, classInfo);
  const defaultValue = Object.prototype.hasOwnProperty.call(opts, "default")
    ? opts.default
    : undefined;

  // A prompt input that is a `[nodeId, slot]` pair is a connection, as is any
  // param the graph walk resolved to a link.
  const linked =
    (graphNode?.linkedParams.has(param) ?? false) || isLinkValue(promptValue);

  const rawValue = linked
    ? undefined
    : hasPromptValue
      ? promptValue
      : (graphValue ?? defaultValue);

  if (
    !definition &&
    rawValue === undefined &&
    graphValue === undefined &&
    !linked
  ) {
    // Nothing declares this param and nothing carries a value for it.
    return null;
  }

  const declaredValueType = definition
    ? getWidgetValueTypeFromTypeSpec(typeSpec, opts)
    : null;

  return Object.freeze({
    nodeId,
    param,
    valueType:
      declaredValueType ?? inferWidgetValueType(rawValue ?? defaultValue),
    value: toJsonValue(rawValue),
    defaultValue: toJsonValue(defaultValue),
    // Copied, never the caller's array: `coerceWidgetOptions` can hand back
    // the live `object_info` list, and freezing that would mutate store state
    // the rest of the app still writes to.
    options: freezeOptions(coerceWidgetOptions(typeSpec, opts)),
    min: typeof opts.min === "number" ? opts.min : null,
    max: typeof opts.max === "number" ? opts.max : null,
    step: typeof opts.step === "number" ? opts.step : null,
    linked,
    controlAfterGenerate: hasControlAfterGenerate(opts),
  }) as GenerationWidgetSnapshot;
}

/**
 * Build the immutable node/widget catalogue for the mounted workflow.
 *
 * `workflow` is the API-prompt form when one has been synced; otherwise the
 * catalogue comes from the visual graph alone, which is what the panel sees
 * before the first prompt conversion.
 */
export function buildGenerationNodeCatalogue(
  workflow: Record<string, unknown> | null,
  objectInfo: Record<string, unknown> | null,
  graphData: Record<string, unknown> | null,
): readonly GenerationNodeSnapshot[] {
  if (!workflow && !graphData) {
    return Object.freeze([]);
  }

  const graphNodesById = buildFlatGraphNodeIndex(graphData);

  function graphEntry(flat: FlatGraphNode): [string, Record<string, unknown>] {
    return [
      flat.nodeId,
      {
        class_type: flat.classType || undefined,
        inputs: {},
        _meta:
          typeof flat.node.title === "string" ? { title: flat.node.title } : {},
      },
    ];
  }

  // Prompt nodes first, then every graph node the prompt does not contain.
  // `graphToPrompt` prunes muted and bypassed nodes, and a catalogue that
  // reports each node's `mode` has to be able to show them — otherwise a
  // bypassed node is indistinguishable from a deleted one.
  const entries: Array<[string, Record<string, unknown>]> = [];
  if (workflow) {
    for (const [nodeId, nodeData] of Object.entries(workflow)) {
      if (isRecord(nodeData)) entries.push([nodeId, nodeData]);
    }
    const promptIds = new Set(entries.map(([nodeId]) => nodeId));
    for (const flat of graphNodesById.values()) {
      if (!promptIds.has(flat.nodeId)) entries.push(graphEntry(flat));
    }
  } else {
    for (const flat of graphNodesById.values()) entries.push(graphEntry(flat));
  }

  const nodes: GenerationNodeSnapshot[] = [];
  for (const [nodeId, nodeData] of entries) {
    const graphNode = graphNodesById.get(nodeId) ?? null;
    const classType =
      (typeof nodeData.class_type === "string"
        ? nodeData.class_type
        : graphNode?.classType) ?? "";
    const meta = isRecord(nodeData._meta) ? nodeData._meta : null;
    const title =
      resolveNodeDisplayTitle({
        workflowTitle: meta?.title,
        graphTitle: graphNode?.node.title,
        classType,
        objectInfo,
      }) ?? `Node ${nodeId}`;

    const nodeInputs = isRecord(nodeData.inputs) ? nodeData.inputs : {};
    const classInfo = resolveClassInfo(objectInfo, classType);
    const inputSpec = resolveInputSpec(classInfo);

    const widgets: GenerationWidgetSnapshot[] = [];
    const seenParams = new Set<string>();

    for (const param of getOrderedObjectInfoParams(inputSpec, classInfo)) {
      const definition = resolveParamDefinition(inputSpec, param);
      // Params whose type spec names a node connection (MODEL, LATENT, …)
      // carry no widget value at all.
      if (
        definition &&
        getWidgetValueTypeFromTypeSpec(definition[0], definition[1]) === null
      ) {
        continue;
      }
      const widget = buildWidgetSnapshot({
        nodeId,
        param,
        definition,
        nodeInputs,
        graphNode,
        classInfo,
      });
      if (!widget) continue;
      widgets.push(widget);
      seenParams.add(param);
    }

    // Prompt inputs the class spec doesn't describe — object_info may be
    // missing (cold start) or the node may be a custom class the frontend has
    // never seen. Link-valued inputs stay out; they are connections.
    for (const param of Object.keys(nodeInputs)) {
      if (seenParams.has(param)) continue;
      if (isLinkValue(nodeInputs[param])) continue;
      const widget = buildWidgetSnapshot({
        nodeId,
        param,
        definition: null,
        nodeInputs,
        graphNode,
        classInfo,
      });
      if (!widget) continue;
      widgets.push(widget);
      seenParams.add(param);
    }

    nodes.push(
      Object.freeze({
        id: nodeId,
        classType,
        title,
        mode: resolveNodeMode(nodeData, graphNode),
        widgets: Object.freeze(widgets),
      }) as GenerationNodeSnapshot,
    );
  }

  return Object.freeze(nodes);
}
