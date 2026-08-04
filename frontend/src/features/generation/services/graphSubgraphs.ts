import { isRecord } from "./parsers";
import { canonicalizeWorkflowClassType } from "../utils/workflowClassTypes";

/**
 * Subgraph-aware flattening of a ComfyUI visual workflow graph.
 *
 * ComfyUI's `graphToPrompt` expands every subgraph instance in place and gives
 * the inner nodes execution ids of the form `<instanceId>:<innerId>` (nested as
 * `<a>:<b>:<c>`). Panel discovery has to walk the graph the same way, otherwise
 * anything living inside a subgraph — prompts, seeds, loaders — is invisible to
 * the panel even though it is very much part of the executed prompt.
 *
 * Two subtleties this module handles, both mirroring litegraph's
 * `SubgraphNode` / `ExecutableNodeDTO`:
 *
 * - **Boundary links.** An inner input wired to the definition's input node is
 *   only a real connection when the enclosing instance has that slot wired
 *   externally. Otherwise it is a promoted widget and the widget value is what
 *   executes.
 * - **Promoted widget values.** The value that executes for a promoted widget
 *   lives on the *instance* node's `widgets_values`, not on the inner node
 *   (the two drift apart freely — the inner node keeps whatever it was last
 *   saved with). The instance array holds one entry per definition input slot
 *   that resolves to an inner widget, in definition-input order, which is
 *   exactly what `SubgraphNode._applyPromotedWidgetValues` consumes.
 */

/** Context for resolving an inner node's links against the subgraph boundary:
 * which internal link ids come from the definition's input slots, and which of
 * those slots the enclosing instance node actually has wired externally. */
export interface SubgraphBoundary {
  inputNamesByLinkId: Map<number, string>;
  externallyLinkedInputNames: ReadonlySet<string>;
}

export interface FlatGraphNode {
  /** Execution id: `<id>` at the top level, `<instanceId>:<innerId>` inside a
   * subgraph — the same ids `graphToPrompt` emits. */
  nodeId: string;
  /** The LiteGraph node JSON. */
  node: Record<string, unknown>;
  /** `node.type` as authored; empty when the node carries no type. */
  rawClassType: string;
  /** `node.type` after class-type canonicalization; empty when untyped. */
  classType: string;
  /** Muted (mode 2) or bypassed (mode 4). Such nodes are still listed so
   * callers can resolve them by id, but nothing inside a muted subgraph
   * instance is expanded — `graphToPrompt` drops it. */
  muted: boolean;
  /** Input params that resolve to a link, and so are not editable widgets. */
  linkedParams: Set<string>;
  /** Param → value pushed in by an enclosing instance's promoted widget. This
   * is the value that executes, and it wins over the node's own
   * `widgets_values`. */
  promotedValues: Map<string, unknown>;
  /** Display title of the innermost enclosing subgraph instance, if any. */
  subgraphTitle: string | null;
}

export function collectLinkedInputNames(
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
export function collectSubgraphDefinitions(
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

export function sortNodesByNumericId(rawNodes: unknown[]): unknown[] {
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

interface DefinitionLinkTarget {
  targetNodeId: string;
  targetSlot: number;
}

interface DefinitionLink extends DefinitionLinkTarget {
  id: number;
  originId: string;
  originSlot: number;
}

interface PromotedTarget {
  nodeId: string;
  param: string;
}

/** Links inside a subgraph definition are serialized as objects; the top-level
 * graph uses tuples. Accept both so nested definitions authored by older
 * frontends still resolve. */
function readLink(link: unknown): DefinitionLink | null {
  if (isRecord(link)) {
    const { id, origin_id: originId, origin_slot: originSlot } = link;
    const targetId = link.target_id;
    const targetSlot = link.target_slot;
    if (
      typeof id !== "number" ||
      originId == null ||
      typeof originSlot !== "number" ||
      targetId == null ||
      typeof targetSlot !== "number"
    ) {
      return null;
    }
    return {
      id,
      originId: String(originId),
      originSlot,
      targetNodeId: String(targetId),
      targetSlot,
    };
  }

  if (Array.isArray(link) && link.length >= 5) {
    const [id, originId, originSlot, targetId, targetSlot] = link;
    if (
      typeof id !== "number" ||
      originId == null ||
      typeof originSlot !== "number" ||
      targetId == null ||
      typeof targetSlot !== "number"
    ) {
      return null;
    }
    return {
      id,
      originId: String(originId),
      originSlot,
      targetNodeId: String(targetId),
      targetSlot,
    };
  }

  return null;
}

function resolveInputNodeId(definition: Record<string, unknown>): string {
  const inputNode = definition.inputNode;
  if (isRecord(inputNode) && inputNode.id != null) {
    return String(inputNode.id);
  }
  return "-10";
}

/** For each definition input slot (in slot order), the inner node inputs it
 * feeds. Slots are matched both by their own `linkIds` and by links originating
 * from the definition's input node, so a stale `linkIds` array still resolves. */
function resolveDefinitionSlotTargets(
  definition: Record<string, unknown>,
  nodesById: Map<string, Record<string, unknown>>,
): PromotedTarget[][] {
  const slots = Array.isArray(definition.inputs) ? definition.inputs : [];
  const rawLinks = Array.isArray(definition.links) ? definition.links : [];
  const inputNodeId = resolveInputNodeId(definition);

  const linksById = new Map<number, DefinitionLinkTarget>();
  const targetsByOriginSlot = new Map<number, DefinitionLinkTarget[]>();
  for (const rawLink of rawLinks) {
    const link = readLink(rawLink);
    if (!link) continue;
    const target: DefinitionLinkTarget = {
      targetNodeId: link.targetNodeId,
      targetSlot: link.targetSlot,
    };
    linksById.set(link.id, target);
    if (link.originId === inputNodeId) {
      const existing = targetsByOriginSlot.get(link.originSlot);
      if (existing) {
        existing.push(target);
      } else {
        targetsByOriginSlot.set(link.originSlot, [target]);
      }
    }
  }

  return slots.map((slot, slotIndex) => {
    const candidates: DefinitionLinkTarget[] = [];
    if (isRecord(slot) && Array.isArray(slot.linkIds)) {
      for (const linkId of slot.linkIds) {
        if (typeof linkId !== "number") continue;
        const target = linksById.get(linkId);
        if (target) candidates.push(target);
      }
    }
    candidates.push(...(targetsByOriginSlot.get(slotIndex) ?? []));

    const seen = new Set<string>();
    const targets: PromotedTarget[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.targetNodeId}:${candidate.targetSlot}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const targetNode = nodesById.get(candidate.targetNodeId);
      if (!targetNode) continue;
      const targetInputs = Array.isArray(targetNode.inputs)
        ? targetNode.inputs
        : [];
      const targetInput = targetInputs[candidate.targetSlot];
      if (!isRecord(targetInput) || typeof targetInput.name !== "string") {
        continue;
      }
      // Only inputs backed by a widget can carry a promoted value; pure
      // connections (IMAGE, MODEL, …) never consume a `widgets_values` slot.
      if (targetInput.widget == null) continue;

      targets.push({
        nodeId: candidate.targetNodeId,
        param: targetInput.name,
      });
    }
    return targets;
  });
}

/**
 * Resolve the promoted widget values an instance node pushes into its inner
 * nodes, keyed by inner node id and param.
 *
 * `overrides` carries values promoted one level further out: when this instance
 * is itself inside a subgraph, the outer instance's value wins over the one
 * serialized here.
 */
function resolvePromotedValues(
  definition: Record<string, unknown>,
  instanceNode: Record<string, unknown>,
  instanceLinkedParams: ReadonlySet<string>,
  overrides: ReadonlyMap<string, unknown>,
): Map<string, Map<string, unknown>> {
  const slots = Array.isArray(definition.inputs) ? definition.inputs : [];
  if (slots.length === 0) return new Map();

  const definitionNodes = Array.isArray(definition.nodes)
    ? definition.nodes
    : [];
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of definitionNodes) {
    if (!isRecord(node) || node.id == null) continue;
    nodesById.set(String(node.id), node);
  }

  const slotTargets = resolveDefinitionSlotTargets(definition, nodesById);
  const widgetsValues = Array.isArray(instanceNode.widgets_values)
    ? instanceNode.widgets_values
    : [];

  const promoted = new Map<string, Map<string, unknown>>();
  let valueIndex = 0;
  for (const [slotIndex, slot] of slots.entries()) {
    const targets = slotTargets[slotIndex] ?? [];
    // Slots that resolve to no widget are skipped without consuming a value —
    // this is what keeps the widgets_values alignment correct.
    if (targets.length === 0) continue;

    const slotName =
      isRecord(slot) && typeof slot.name === "string" ? slot.name : null;
    const value =
      slotName !== null && overrides.has(slotName)
        ? overrides.get(slotName)
        : widgetsValues[valueIndex];
    valueIndex += 1;

    if (value === undefined) continue;
    // An externally wired slot executes the upstream link, not the widget.
    if (slotName !== null && instanceLinkedParams.has(slotName)) continue;

    for (const target of targets) {
      const byParam = promoted.get(target.nodeId);
      if (byParam) {
        byParam.set(target.param, value);
      } else {
        promoted.set(target.nodeId, new Map([[target.param, value]]));
      }
    }
  }

  return promoted;
}

function resolveSubgraphInstanceTitle(
  instanceNode: Record<string, unknown>,
  definition: Record<string, unknown>,
): string | null {
  if (typeof instanceNode.title === "string" && instanceNode.title.trim()) {
    return instanceNode.title.trim();
  }
  if (typeof definition.name === "string" && definition.name.trim()) {
    return definition.name.trim();
  }
  return null;
}

/**
 * Walk a visual workflow graph, expanding subgraph instances in place.
 *
 * Instance nodes themselves are not emitted — only the executable nodes they
 * expand to, in numeric-id order within each graph level. Muted and bypassed
 * nodes are emitted with `muted: true` so callers can resolve them by id;
 * nothing inside a muted subgraph instance is expanded.
 */
export function flattenGraphNodes(
  graphData: Record<string, unknown>,
): FlatGraphNode[] {
  const subgraphsById = collectSubgraphDefinitions(graphData);
  const flattened: FlatGraphNode[] = [];

  const walk = (
    rawNodes: unknown[],
    idPrefix: string,
    boundary: SubgraphBoundary | null,
    promotedByNodeId: ReadonlyMap<string, Map<string, unknown>>,
    subgraphTitle: string | null,
    activeDefinitionIds: ReadonlySet<string>,
  ): void => {
    for (const node of sortNodesByNumericId(rawNodes)) {
      if (!isRecord(node) || node.id == null) continue;
      const muted = node.mode === 2 || node.mode === 4;
      const rawClassType =
        typeof node.type === "string" ? node.type.trim() : "";
      const classType =
        canonicalizeWorkflowClassType(rawClassType) ?? rawClassType;

      const nodeId = `${idPrefix}${node.id}`;
      const linkedParams = collectLinkedInputNames(node, boundary);
      const promotedValues =
        promotedByNodeId.get(String(node.id)) ?? new Map<string, unknown>();

      const definition = muted ? undefined : subgraphsById.get(rawClassType);
      if (definition) {
        // A subgraph instance: expand its definition in place. The id-set
        // guards against (malformed) self-referential definitions.
        if (activeDefinitionIds.has(rawClassType)) continue;
        const definitionNodes = Array.isArray(definition.nodes)
          ? definition.nodes
          : [];
        walk(
          definitionNodes,
          `${nodeId}:`,
          {
            inputNamesByLinkId: buildInputNamesByLinkId(definition),
            externallyLinkedInputNames: linkedParams,
          },
          resolvePromotedValues(
            definition,
            node,
            linkedParams,
            promotedValues,
          ),
          resolveSubgraphInstanceTitle(node, definition),
          new Set(activeDefinitionIds).add(rawClassType),
        );
        continue;
      }

      flattened.push({
        nodeId,
        node,
        rawClassType,
        classType,
        muted,
        linkedParams,
        promotedValues,
        subgraphTitle,
      });
    }
  };

  const rawNodes = Array.isArray(graphData.nodes) ? graphData.nodes : [];
  walk(rawNodes, "", null, new Map(), null, new Set());

  return flattened;
}

/** Which internal link ids originate at the definition's input node, and under
 * which slot name. Resolved from the slots' own `linkIds` *and* from the links
 * themselves — the two disagree on graphs where `linkIds` went stale, and a
 * boundary link missing from this map would be mistaken for a real upstream
 * connection, hiding an editable promoted widget. */
function buildInputNamesByLinkId(
  definition: Record<string, unknown>,
): Map<number, string> {
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

  const inputNodeId = resolveInputNodeId(definition);
  const rawLinks = Array.isArray(definition.links) ? definition.links : [];
  for (const rawLink of rawLinks) {
    const link = readLink(rawLink);
    if (!link || link.originId !== inputNodeId) continue;
    const slot = definitionInputs[link.originSlot];
    if (!isRecord(slot) || typeof slot.name !== "string") continue;
    inputNamesByLinkId.set(link.id, slot.name);
  }

  return inputNamesByLinkId;
}

/** Flattened nodes keyed by execution id, for callers that resolve graph nodes
 * by the ids that appear in an API-shape prompt. */
export function buildFlatGraphNodeIndex(
  graphData: Record<string, unknown> | null,
): Map<string, FlatGraphNode> {
  const index = new Map<string, FlatGraphNode>();
  if (!graphData) return index;
  for (const flat of flattenGraphNodes(graphData)) {
    index.set(flat.nodeId, flat);
  }
  return index;
}
