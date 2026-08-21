export const BRIDGE_PROTOCOL = "vlo-bridge";
// v4 exposes ComfyUI's persistent client id during the handshake so the host
// can attribute proxied prompt submissions without navigating the iframe.
export const BRIDGE_VERSION = 4;
export const BRIDGE_CAPABILITIES = Object.freeze([
  "health",
  "health-changed",
  "read-active",
  "read-pending-warnings",
  "inject-workflow",
  "resolve-prompt",
  "refresh-missing-models",
  "graph-changed",
  "workflow-revision",
  "drop-asset",
  // Drops carry the asset file itself rather than a parent-staged filename, so
  // the target node can run its own upload. A runtime without this capability
  // would silently ignore the file and drop nothing.
  "drop-asset-file",
  "client-id",
]);

const APP_READY_POLL_MS = 100;
const APP_READY_TIMEOUT_MS = 15_000;
const WORKFLOW_ACTIVE_TIMEOUT_MS = 3_000;
const WARNING_CAPTURE_POLL_MS = 50;
const WARNING_CAPTURE_TIMEOUT_MS = 1_000;
const GRAPH_CHANGED_DEBOUNCE_MS = 300;
const MAX_PENDING_IFRAME_GENERATIONS = 256;
// Temporary workflow metadata used to prove that graphToPrompt serialized the
// graph supplied by vlo. Some frontend extensions monkey-patch graphToPrompt;
// a wrapper that drops its arguments otherwise falls back to app.rootGraph and
// returns a valid-looking prompt for the wrong graph.
const PROMPT_GRAPH_NONCE_KEY = "__vloPromptGraphNonce";
// Matches ComfyUI's own per-file upload bound (useNodeImageUpload), so the
// fallback path fails with a typed error rather than running until the parent's
// request timeout gives up on it.
const UPLOAD_TIMEOUT_MS = 120_000;

class BridgeRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BridgeRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(windowObject, milliseconds) {
  return new Promise((resolve) => windowObject.setTimeout(resolve, milliseconds));
}

function normalizeFilename(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = trimmed.split("/").filter(Boolean);
  return (segments.at(-1) ?? trimmed).trim() || null;
}

function resolveTabFilename(workflow) {
  if (!workflow) return null;
  for (const candidate of [
    workflow.filename,
    workflow.fullFilename,
    workflow.key,
    workflow.path,
  ]) {
    const normalized = normalizeFilename(candidate);
    if (normalized) return normalized;
  }
  return null;
}

// ComfyUI's workflow.filename strips the ".json" extension while injected
// workflow ids usually carry it, so filename comparisons must use stems.
function filenameStem(value) {
  const normalized = normalizeFilename(value);
  return normalized ? normalized.replace(/\.json$/i, "") : null;
}

// ComfyUI de-duplicates colliding tab names as "<stem> (2)", "<stem> (3)", …
function stemMatchesExpected(activeStem, expectedStem) {
  if (!activeStem || !expectedStem) return false;
  if (activeStem === expectedStem) return true;
  return (
    activeStem.startsWith(`${expectedStem} (`) &&
    /^ \(\d+\)$/.test(activeStem.slice(expectedStem.length))
  );
}

function cloneValue(windowObject, value) {
  const clone = windowObject.structuredClone ?? globalThis.structuredClone;
  if (typeof clone === "function") {
    try {
      return clone(value);
    } catch {
      // ComfyUI ≥1.45 exposes activeWorkflow.activeState as a Vue reactive
      // Proxy, which the structured clone algorithm rejects (DataCloneError).
    }
  }
  // Workflow state is JSON-serializable by definition (it round-trips to
  // disk), so a JSON clone is lossless where it matters and reads through
  // proxies.
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeLink(link) {
  // Endpoint node ids only: ComfyUI renumbers slot indexes on load
  // (widget→input conversion shifts them) and can resolve wildcard ("*")
  // link types, so slots and types are not load-stable.
  const endpoints = Array.isArray(link)
    ? [link[1], link[3]]
    : isRecord(link)
      ? [link.origin_id, link.target_id]
      : null;
  if (!endpoints) return null;
  return endpoints.map((value) =>
    typeof value === "number" || typeof value === "string" ? String(value) : null,
  );
}

function structuralGraphShape(graphData) {
  if (!isRecord(graphData)) return null;
  const nodes = Array.isArray(graphData.nodes)
    ? graphData.nodes
        .filter(isRecord)
        .map((node) => ({
          id:
            typeof node.id === "number" || typeof node.id === "string"
              ? String(node.id)
              : "",
          type: typeof node.type === "string" ? node.type : "",
        }))
        .sort((left, right) =>
          `${left.id}:${left.type}`.localeCompare(`${right.id}:${right.type}`),
        )
    : [];
  const links = Array.isArray(graphData.links)
    ? graphData.links
        .map(normalizeLink)
        .filter((link) => link !== null)
        .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
    : [];
  const definitions = isRecord(graphData.definitions) ? graphData.definitions : null;
  const subgraphs = Array.isArray(definitions?.subgraphs)
    ? definitions.subgraphs
        .map((entry) => structuralGraphShape(entry))
        .filter((entry) => entry !== null)
    : [];
  return { nodes, links, subgraphs };
}

export function fingerprintWorkflow(graphData) {
  const shape = structuralGraphShape(graphData);
  return shape === null ? null : stableStringify(shape);
}

function toUnique(values) {
  return [...new Set(values)];
}

function extractMissingNodeTypes(value) {
  if (!Array.isArray(value)) return [];
  return toUnique(
    value
      .map((entry) => {
        if (typeof entry === "string") return entry.trim() || null;
        if (!isRecord(entry)) return null;
        if (typeof entry.type === "string" && entry.type.trim()) return entry.type.trim();
        if (typeof entry.class_type === "string" && entry.class_type.trim()) {
          return entry.class_type.trim();
        }
        return null;
      })
      .filter(Boolean),
  );
}

function extractMissingModels(value) {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) &&
        (Array.isArray(value.missingModelCandidates) || Array.isArray(value.missingModels))
      ? (value.missingModelCandidates ?? value.missingModels)
      : [];
  return toUnique(
    entries
      .map((entry) => {
        if (typeof entry === "string") return entry.trim() || null;
        if (!isRecord(entry)) return null;
        if ("isMissing" in entry && entry.isMissing !== true) return null;
        for (const candidate of [
          entry.name,
          entry.file_name,
          entry.filename,
          entry.url,
          entry.hash,
        ]) {
          if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
        }
        return null;
      })
      .filter(Boolean),
  );
}

function readWarnings(workflow, clear) {
  if (!workflow || !isRecord(workflow.pendingWarnings)) return null;
  const missingNodeTypes = extractMissingNodeTypes(workflow.pendingWarnings.missingNodeTypes);
  const missingModels = extractMissingModels(
    workflow.pendingWarnings.missingModelCandidates ?? workflow.pendingWarnings.missingModels,
  );
  if (clear) workflow.pendingWarnings = null;
  if (missingNodeTypes.length === 0 && missingModels.length === 0) return null;
  return { missingNodeTypes, missingModels };
}

// Mirrors the backend's bool-like coercion for loader widget values such as
// vloMemory loaders' `disable_in_memory` (booleans, 0/1, "true"/"false").
function isTruthyWidgetValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function findNodeWidget(node, widgetName) {
  if (!Array.isArray(node?.widgets)) return null;
  return node.widgets.find((widget) => widget?.name === widgetName) ?? null;
}

/**
 * Whether an input slot of this name carries a link, in which case the node's
 * own widget value is not what executes and writing it changes nothing.
 *
 * `graphToPrompt` fills `inputs[name]` from the widget list first, then
 * overwrites it with `ExecutableNodeDTO.resolveInput` for every *connected*
 * input. Two shapes end up here:
 *
 * - A plain upstream connection, which wins over the widget.
 * - A promoted widget inside a subgraph: the inner input is wired to the
 *   definition's input node, and `resolveInput` returns the value held by the
 *   *enclosing instance's* widget — the same rule `resolveGraphWidgetValue`
 *   follows on the vlo side.
 *
 * Either way the requested value would never reach the prompt, so the write is
 * rejected instead of reported as applied. Routing such a write to the
 * enclosing instance is the decision-gated follow-on in
 * docs/generation-native-extension-seams-plan.md §7.
 */
function isLinkedNodeInput(node, name) {
  const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
  return inputs.some(
    (input) => isRecord(input) && input.name === name && input.link != null,
  );
}

function getNodeByExternalId(graph, rawId) {
  let node = graph.getNodeById(rawId);
  if (!node && typeof rawId === "string" && /^-?\d+$/.test(rawId)) {
    node = graph.getNodeById(Number(rawId));
  }
  return node;
}

// Effect targets are addressed by the execution ids `graphToPrompt` emits:
// `<id>` at the root and `<instanceId>:<innerId>` (nested `<a>:<b>:<c>`) inside
// a subgraph instance. The root graph has never heard of a scoped id, so
// resolution walks the instance chain instead of asking it.
const EXECUTION_ID_SEPARATOR = ":";
// Bounds the expansion walk below on a pathological graph. Reaching it fails
// scoped targets closed rather than guessing at their isolation.
const MAX_GRAPH_WALK_NODES = 50_000;

/** Duck-typed subgraph instance: a node whose `subgraph` is itself a graph. */
function getInstanceSubgraph(node) {
  const subgraph = node?.subgraph;
  return isRecord(subgraph) && typeof subgraph.getNodeById === "function"
    ? subgraph
    : null;
}

/**
 * How many execution ids each node object answers to once every subgraph
 * instance is expanded.
 *
 * litegraph hands every instance of a subgraph definition the *same* inner node
 * objects — `SubgraphNode.getInnerNodes` wraps `this.subgraph.nodes` in
 * per-instance DTOs, but `mode` and `widgets` still read through to the one
 * shared node. A node reached by more than one path therefore cannot be written
 * without its sibling instances inheriting the change, which is exactly what
 * scoped targeting must not do.
 *
 * Modes are ignored on purpose: a bypassed sibling still counts, because effect
 * application order would otherwise decide whether a write is isolated.
 */
function countNodeExecutionPaths(rootGraph) {
  const counts = new Map();
  let budget = MAX_GRAPH_WALK_NODES;
  let overflowed = false;

  const walk = (graph, openSubgraphs) => {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    for (const node of nodes) {
      if (budget <= 0) {
        overflowed = true;
        return;
      }
      budget -= 1;
      counts.set(node, (counts.get(node) ?? 0) + 1);

      const subgraph = getInstanceSubgraph(node);
      // A definition that (illegally) contains itself would otherwise recurse
      // forever; litegraph rejects such graphs at execution time too.
      if (!subgraph || openSubgraphs.has(subgraph)) continue;
      openSubgraphs.add(subgraph);
      walk(subgraph, openSubgraphs);
      openSubgraphs.delete(subgraph);
    }
  };
  walk(rootGraph, new Set());

  return { counts, overflowed };
}

/**
 * Resolve one execution id against the temporary graph.
 *
 * Returns `{ node, executionId }` for a target that can be written in
 * isolation, otherwise `{ reason }`. `executionId` is rebuilt from the resolved
 * nodes so it matches what `graphToPrompt` will emit, even when the request
 * used a numeric-vs-string spelling of an id.
 */
function resolveEffectTarget(rootGraph, rawId, executionPathCounts) {
  const segments = String(rawId).split(EXECUTION_ID_SEPARATOR);
  const scoped = segments.length > 1;
  if (scoped && executionPathCounts?.overflowed) {
    return { reason: "graph-too-large" };
  }

  let graph = rootGraph;
  const resolvedSegments = [];
  for (const [index, segment] of segments.entries()) {
    if (!graph || typeof graph.getNodeById !== "function") {
      return { reason: "node-not-found" };
    }
    const node = getNodeByExternalId(graph, segment);
    if (!node) return { reason: "node-not-found" };
    resolvedSegments.push(String(node.id));

    if (index < segments.length - 1) {
      const subgraph = getInstanceSubgraph(node);
      if (!subgraph) return { reason: "not-a-subgraph-instance" };
      graph = subgraph;
      continue;
    }

    if ((executionPathCounts?.counts.get(node) ?? 1) > 1) {
      return { reason: "shared-subgraph-instance" };
    }
    return {
      node,
      executionId: resolvedSegments.join(EXECUTION_ID_SEPARATOR),
    };
  }
  return { reason: "node-not-found" };
}

function describeUnresolvedTargets(nodeTargets, widgetOverrides) {
  return [
    ...nodeTargets.map(({ nodeId, reason }) => `${nodeId} (${reason})`),
    ...widgetOverrides.map(
      ({ nodeId, widget, reason }) => `${nodeId}.${widget} (${reason})`,
    ),
  ].join(", ");
}

function resolveNodeTargets(graph, nodeIds, executionPathCounts) {
  const targets = [];
  const unresolved = [];
  const seen = new Set();
  for (const nodeId of nodeIds) {
    const externalNodeId = String(nodeId);
    if (seen.has(externalNodeId)) continue;
    seen.add(externalNodeId);

    const resolved = resolveEffectTarget(graph, nodeId, executionPathCounts);
    if (resolved.node) {
      targets.push(resolved);
    } else {
      unresolved.push({ nodeId: externalNodeId, reason: resolved.reason });
    }
  }
  return { targets, unresolved };
}

function applyOverridesToGraph(
  graph,
  bypassNodeIds,
  widgetOverrides,
  activateNodeIds = [],
) {
  const addressesSubgraph = [
    ...bypassNodeIds,
    ...activateNodeIds,
    ...widgetOverrides.map((override) =>
      isRecord(override) ? override.node_id : null,
    ),
  ].some(
    (nodeId) =>
      typeof nodeId === "string" && nodeId.includes(EXECUTION_ID_SEPARATOR),
  );
  // Only pay for the expansion walk when something is actually addressed inside
  // a subgraph; root-only effects resolve exactly as they always have.
  const executionPathCounts = addressesSubgraph
    ? countNodeExecutionPaths(graph)
    : null;

  const { targets: bypassTargets, unresolved: unresolvedBypassNodeIds } =
    resolveNodeTargets(graph, bypassNodeIds, executionPathCounts);
  const { targets: activateTargets, unresolved: unresolvedActivateNodeIds } =
    resolveNodeTargets(graph, activateNodeIds, executionPathCounts);

  const widgetTargets = [];
  const unresolvedWidgetOverrides = [];
  for (const [index, override] of widgetOverrides.entries()) {
    if (!isRecord(override) || typeof override.widget !== "string") {
      unresolvedWidgetOverrides.push({
        index,
        nodeId:
          isRecord(override) &&
          (typeof override.node_id === "string" || typeof override.node_id === "number")
            ? String(override.node_id)
            : null,
        widget:
          isRecord(override) && typeof override.widget === "string"
            ? override.widget
            : null,
        reason: "invalid-override",
      });
      continue;
    }

    const resolved = resolveEffectTarget(
      graph,
      override.node_id,
      executionPathCounts,
    );
    if (!resolved.node) {
      unresolvedWidgetOverrides.push({
        index,
        nodeId: String(override.node_id),
        widget: override.widget,
        reason: resolved.reason,
      });
      continue;
    }
    const widget = findNodeWidget(resolved.node, override.widget);
    if (!widget) {
      unresolvedWidgetOverrides.push({
        index,
        nodeId: String(override.node_id),
        widget: override.widget,
        reason: "widget-not-found",
      });
      continue;
    }
    if (isLinkedNodeInput(resolved.node, override.widget)) {
      unresolvedWidgetOverrides.push({
        index,
        nodeId: String(override.node_id),
        widget: override.widget,
        reason: "widget-not-executed",
      });
      continue;
    }
    widgetTargets.push({ override, widget });
  }

  if (
    unresolvedBypassNodeIds.length > 0 ||
    unresolvedActivateNodeIds.length > 0 ||
    unresolvedWidgetOverrides.length > 0
  ) {
    throw new BridgeRuntimeError(
      "graph-override-target-missing",
      "Could not resolve every bypass, activation or widget override against the " +
        `temporary ComfyUI graph: ${describeUnresolvedTargets(
          [...unresolvedBypassNodeIds, ...unresolvedActivateNodeIds],
          unresolvedWidgetOverrides,
        )}`,
      {
        bypassNodeIds: unresolvedBypassNodeIds,
        activateNodeIds: unresolvedActivateNodeIds,
        widgetOverrides: unresolvedWidgetOverrides,
      },
    );
  }

  const appliedBypassExecutionIds = [];
  for (const { node, executionId } of bypassTargets) {
    node.mode = 4;
    appliedBypassExecutionIds.push(executionId);
  }
  // Apply second so bypass remains the fail-safe winner for malformed payloads.
  const appliedActivateExecutionIds = [];
  for (const { node, executionId } of activateTargets) {
    if (appliedBypassExecutionIds.includes(executionId)) continue;
    node.mode = 0;
    appliedActivateExecutionIds.push(executionId);
  }
  // Node objects are recreated by `configure`, so `mode` is private to the
  // clone. Widget *values* are not: current ComfyUI keys widget state by
  // (root graph id, node id, widget name) in a store, and the clone inherits
  // the live graph's id, so an override can land on the live editor's widget.
  // Remembering the previous value lets prompt resolution put it back.
  const widgetRestores = [];
  try {
    for (const { override, widget } of widgetTargets) {
      // Recorded before the write: a setter that throws may already have
      // changed the value, and the caller never sees this list if we throw.
      const restore = { widget, previousValue: widget.value, applied: false };
      widgetRestores.push(restore);
      widget.value = override.value;
      // What the widget actually holds, which a coercing setter may have
      // normalized away from the requested value.
      restore.appliedValue = widget.value;
      restore.applied = true;
    }
  } catch (error) {
    // Custom widgets can install arbitrary setters. Leaving the earlier writes
    // installed would strand them on the live editor, and the throw means the
    // caller never receives the list it would restore them from.
    restoreWidgetValues(widgetRestores);
    throw new BridgeRuntimeError(
      "graph-override-apply-failed",
      "A ComfyUI widget rejected an override value",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
  return {
    appliedBypassExecutionIds,
    appliedActivateExecutionIds,
    widgetRestores,
  };
}

function restoreWidgetValues(widgetRestores) {
  for (const restore of widgetRestores) {
    try {
      // Compare-and-restore. The live editor reads the very widget state this
      // resolution wrote, and `graphToPrompt` is awaited, so the user can edit
      // that widget while a resolution is in flight. Putting the old value
      // back unconditionally would erase their edit. Only restore while the
      // widget still holds exactly what this resolution installed; anything
      // else means someone took ownership of it and their value stands.
      if (
        restore.applied &&
        !Object.is(restore.widget.value, restore.appliedValue)
      ) {
        continue;
      }
      restore.widget.value = restore.previousValue;
    } catch (error) {
      console.warn("[vlo-bridge] could not restore widget value:", error);
    }
  }
}

function isSameOriginEmbedded(windowObject) {
  try {
    return (
      windowObject.parent &&
      windowObject.parent !== windowObject &&
      windowObject.parent.location.origin === windowObject.location.origin
    );
  } catch {
    return false;
  }
}

export function startVloBridge({ app, api, windowObject = window }) {
  if (!isSameOriginEmbedded(windowObject)) return null;

  // Identifies this document to the parent. A reload replaces the runtime but
  // not the iframe element, so the parent cannot otherwise tell an answer from
  // the outgoing document apart from one by the document replacing it.
  const documentId =
    windowObject.crypto?.randomUUID?.() ??
    `document-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let activeChannelId = null;
  let bridgeReady = false;
  let workflowCounter = 0;
  let promptResolutionCounter = 0;
  let graphChangedTimer = null;
  let announcePending = false;
  let stopped = false;
  const workflowIds = new WeakMap();
  const workflowRevisions = new WeakMap();

  const getWorkflowApi = () => app?.extensionManager?.workflow ?? null;
  const getActiveWorkflow = () => getWorkflowApi()?.activeWorkflow ?? null;
  const getRootGraph = () => app?.rootGraph ?? app?.graph ?? null;

  function getWorkflowId(workflow) {
    let value = workflowIds.get(workflow);
    if (!value) {
      const randomUuid = windowObject.crypto?.randomUUID?.();
      value = randomUuid ?? `workflow-${++workflowCounter}`;
      workflowIds.set(workflow, value);
      workflowRevisions.set(workflow, 0);
    }
    return value;
  }

  function getWorkflowRevision(workflow) {
    getWorkflowId(workflow);
    return workflowRevisions.get(workflow) ?? 0;
  }

  function invokeGraphToPrompt(tempGraph) {
    const previousRootGraphDescriptor = Object.getOwnPropertyDescriptor(
      app,
      "rootGraph",
    );
    let installedTemporaryRoot = false;

    // ComfyUI-Manager versions with the broken wrapper call the original
    // graphToPrompt synchronously but omit its argument. Exposing the clone as
    // app.rootGraph for this call stack lets the original default parameter
    // select it too. Restore before awaiting so UI events cannot observe the
    // temporary root during asynchronous extension post-processing.
    try {
      if (
        previousRootGraphDescriptor &&
        previousRootGraphDescriptor.configurable === false
      ) {
        // A non-configurable writable data property can change value without
        // changing its descriptor flags.
        Object.defineProperty(app, "rootGraph", { value: tempGraph });
      } else {
        // Current ComfyUI exposes rootGraph as a getter-only prototype
        // property. An own data property safely shadows that getter for the
        // synchronous wrapper call without touching rootGraphInternal.
        Object.defineProperty(app, "rootGraph", {
          configurable: true,
          enumerable: previousRootGraphDescriptor?.enumerable ?? false,
          writable: true,
          value: tempGraph,
        });
      }
      installedTemporaryRoot = app.rootGraph === tempGraph;
    } catch {
      // A non-extensible or otherwise locked future app still receives the
      // explicit argument; the nonce check will reject a broken wrapper.
    }

    try {
      return app.graphToPrompt(tempGraph);
    } finally {
      if (installedTemporaryRoot) {
        if (previousRootGraphDescriptor) {
          Object.defineProperty(
            app,
            "rootGraph",
            previousRootGraphDescriptor,
          );
        } else {
          delete app.rootGraph;
        }
      }
    }
  }

  function incrementActiveRevision() {
    const active = getActiveWorkflow();
    if (!active) return;
    workflowRevisions.set(active, getWorkflowRevision(active) + 1);
  }

  function isAppReady() {
    try {
      const manager = app?.extensionManager;
      return (
        typeof app?.handleFile === "function" &&
        Boolean(app.canvas) &&
        Boolean(manager?.workflow?.activeWorkflow) &&
        manager.spinner !== true
      );
    } catch {
      return false;
    }
  }

  function isBackendConnected() {
    try {
      const socket = api?.socket ?? app?.api?.socket;
      if (!socket) return isAppReady();
      if (typeof socket.connected === "boolean") return socket.connected;
      const openState = typeof socket.OPEN === "number" ? socket.OPEN : 1;
      return socket.readyState === openState;
    } catch {
      return false;
    }
  }

  async function waitForAppReady(timeoutMs = APP_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!stopped && Date.now() < deadline) {
      if (isAppReady()) return true;
      await sleep(windowObject, APP_READY_POLL_MS);
    }
    return false;
  }

  function post(message) {
    if (!activeChannelId || stopped) return;
    windowObject.parent.postMessage(
      {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        channelId: activeChannelId,
        // Every message, not just the handshake: responses and push events
        // emitted while a document unloads must be attributable too.
        documentId,
        ...message,
      },
      windowObject.location.origin,
    );
  }

  function readActive() {
    const active = getActiveWorkflow();
    if (!active || !isRecord(active.activeState)) return null;
    return {
      graphData: cloneValue(windowObject, active.activeState),
      filename: resolveTabFilename(active),
      isModified: active.isModified === true,
      workflowInstanceId: getWorkflowId(active),
      revision: getWorkflowRevision(active),
    };
  }

  function announceReady() {
    if (!isAppReady()) return false;
    const clientId =
      typeof api?.clientId === "string" && api.clientId.trim()
        ? api.clientId.trim()
        : null;
    if (clientId === null) return false;
    post({
      type: "ready",
      capabilities: BRIDGE_CAPABILITIES,
      clientId,
    });
    bridgeReady = true;
    flushPendingIframeGenerationEvents();
    return true;
  }

  // The parent retries `hello` while it waits, so without this guard every
  // retry would start another readiness poll against the same app.
  async function announceWhenReady() {
    if (announcePending) return;
    announcePending = true;
    try {
      if (await waitForAppReady()) announceReady();
    } finally {
      announcePending = false;
    }
  }

  async function captureWarnings(workflow) {
    const deadline = Date.now() + WARNING_CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const warnings = readWarnings(workflow, true);
      if (warnings) return warnings;
      await sleep(windowObject, WARNING_CAPTURE_POLL_MS);
    }
    return null;
  }

  async function waitForInjectedWorkflow(graphData, filename, previousActive) {
    const expectedFingerprint = fingerprintWorkflow(graphData);
    const expectedStem = filenameStem(filename);
    const deadline = Date.now() + WORKFLOW_ACTIVE_TIMEOUT_MS;
    let lastObservation = null;
    while (Date.now() < deadline) {
      const active = getActiveWorkflow();
      const fingerprintMatches =
        fingerprintWorkflow(active?.activeState) === expectedFingerprint;
      const activeStem = filenameStem(resolveTabFilename(active));
      const stemMatches =
        !expectedStem || stemMatchesExpected(activeStem, expectedStem);
      lastObservation = { activeStem, stemMatches, fingerprintMatches };
      if (active && fingerprintMatches) {
        // A fingerprint hit on a tab that either carries the injected name or
        // only just became active is our injection; anything stricter trips
        // over ComfyUI's tab-naming quirks.
        if (stemMatches || active !== previousActive) return active;
      }
      await sleep(windowObject, APP_READY_POLL_MS);
    }
    throw new BridgeRuntimeError(
      "workflow-not-active",
      "The injected workflow did not become the active ComfyUI workflow",
      { expectedStem, ...lastObservation },
    );
  }

  async function closeOtherWorkflowTabs(keep) {
    const workflowApi = getWorkflowApi();
    if (!workflowApi || typeof workflowApi.closeWorkflow !== "function") return;
    // `workflows` lists every persisted workflow and template, not tabs;
    // only `openWorkflows` is safe to close.
    const open = workflowApi.openWorkflows ?? [];
    for (const workflow of open) {
      if (workflow === keep) continue;
      try {
        await workflowApi.closeWorkflow(workflow);
      } catch (error) {
        console.warn("[vlo-bridge] closeWorkflow failed:", error);
      }
    }
  }

  async function injectWorkflow(payload) {
    if (!isRecord(payload?.graphData)) {
      throw new BridgeRuntimeError("invalid-payload", "inject-workflow requires graphData");
    }
    if (!(await waitForAppReady())) {
      throw new BridgeRuntimeError("app-not-ready", "ComfyUI is not ready");
    }
    const filename =
      typeof payload.filename === "string" && payload.filename.trim()
        ? payload.filename
        : "workflow.json";
    const blob = new windowObject.Blob([JSON.stringify(payload.graphData)], {
      type: "application/json",
    });
    const file = new windowObject.File([blob], filename, { type: "application/json" });
    const previousActive = getActiveWorkflow();
    await app.handleFile(file, undefined, { deferWarnings: true });
    const active = await waitForInjectedWorkflow(
      payload.graphData,
      filename,
      previousActive,
    );
    const warnings = await captureWarnings(active);
    await closeOtherWorkflowTabs(active);
    return { snapshot: readActive(), warnings };
  }

  function assertExpectedWorkflow(payload) {
    const snapshot = readActive();
    if (!snapshot) {
      throw new BridgeRuntimeError("workflow-unavailable", "No active ComfyUI workflow exists");
    }
    if (
      snapshot.workflowInstanceId !== payload?.workflowInstanceId ||
      snapshot.revision !== payload?.revision
    ) {
      throw new BridgeRuntimeError(
        "workflow-changed",
        "The ComfyUI workflow changed before prompt resolution",
        {
          expectedWorkflowInstanceId: payload?.workflowInstanceId,
          actualWorkflowInstanceId: snapshot.workflowInstanceId,
          expectedRevision: payload?.revision,
          actualRevision: snapshot.revision,
        },
      );
    }
    return snapshot;
  }

  async function resolvePromptExclusive(payload) {
    const before = assertExpectedWorkflow(payload);
    const LGraphCtor = windowObject.LGraph ?? windowObject.LiteGraph?.LGraph;
    if (typeof LGraphCtor !== "function") {
      throw new BridgeRuntimeError(
        "clone-unavailable",
        "ComfyUI did not expose an LGraph constructor for safe prompt resolution",
      );
    }
    const rootGraph = getRootGraph();
    if (!rootGraph || typeof rootGraph.serialize !== "function") {
      throw new BridgeRuntimeError("workflow-unavailable", "ComfyUI graph is unavailable");
    }

    let tempGraph;
    try {
      const serialized = cloneValue(windowObject, rootGraph.serialize());
      tempGraph = new LGraphCtor();
      tempGraph.configure(serialized);
    } catch (error) {
      throw new BridgeRuntimeError(
        "clone-configure-failed",
        "Could not configure a temporary ComfyUI graph",
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }

    const {
      appliedBypassExecutionIds,
      appliedActivateExecutionIds,
      widgetRestores,
    } = applyOverridesToGraph(
      tempGraph,
      Array.isArray(payload?.bypassNodeIds) ? payload.bypassNodeIds : [],
      Array.isArray(payload?.widgetOverrides) ? payload.widgetOverrides : [],
      Array.isArray(payload?.activateNodeIds) ? payload.activateNodeIds : [],
    );
    const randomNonce = windowObject.crypto?.randomUUID?.() ?? Date.now().toString(36);
    const promptGraphNonce = `${++promptResolutionCounter}:${randomNonce}`;
    const tempGraphExtra = isRecord(tempGraph.extra) ? tempGraph.extra : {};
    const hadPromptGraphNonce = Object.prototype.hasOwnProperty.call(
      tempGraphExtra,
      PROMPT_GRAPH_NONCE_KEY,
    );
    const previousPromptGraphNonce = tempGraphExtra[PROMPT_GRAPH_NONCE_KEY];
    tempGraph.extra = {
      ...tempGraphExtra,
      [PROMPT_GRAPH_NONCE_KEY]: promptGraphNonce,
    };

    let resolved;
    try {
      const pendingResolution = invokeGraphToPrompt(tempGraph);
      resolved = await pendingResolution;
    } catch (error) {
      throw new BridgeRuntimeError(
        "graph-to-prompt-failed",
        "ComfyUI could not resolve the temporary graph",
        { reason: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      restoreWidgetValues(widgetRestores);
    }
    const after = assertExpectedWorkflow(payload);
    if (
      before.workflowInstanceId !== after.workflowInstanceId ||
      before.revision !== after.revision
    ) {
      throw new BridgeRuntimeError(
        "workflow-changed",
        "The ComfyUI workflow changed during prompt resolution",
      );
    }
    if (!isRecord(resolved?.output)) {
      throw new BridgeRuntimeError(
        "invalid-prompt-result",
        "ComfyUI graphToPrompt returned an invalid result",
      );
    }
    if (
      !isRecord(resolved.workflow) ||
      !isRecord(resolved.workflow.extra) ||
      resolved.workflow.extra[PROMPT_GRAPH_NONCE_KEY] !== promptGraphNonce
    ) {
      throw new BridgeRuntimeError(
        "graph-argument-ignored",
        "A ComfyUI frontend extension ignored or replaced vlo's temporary prompt graph",
        {
          hint:
            "Update installed frontend extensions and inspect graphToPrompt wrappers for an argument that is not forwarded",
        },
      );
    }
    // A bypassed subgraph instance is never itself a prompt node, so its
    // verification is the absence of anything it expands to. `graphToPrompt`
    // skips expansion for a bypassed *root* instance, but its inner-node walk
    // does not re-check mode further down, so a nested bypassed instance can
    // still emit `a:b:…` nodes. Failing closed there beats running work the
    // user asked to skip.
    const promptNodeIds = Object.keys(resolved.output);
    const leakedBypassNodeIds = appliedBypassExecutionIds.filter(
      (executionId) =>
        Object.prototype.hasOwnProperty.call(resolved.output, executionId) ||
        promptNodeIds.some((promptNodeId) =>
          promptNodeId.startsWith(`${executionId}${EXECUTION_ID_SEPARATOR}`),
        ),
    );
    if (leakedBypassNodeIds.length > 0) {
      throw new BridgeRuntimeError(
        "bypass-verification-failed",
        "ComfyUI included bypassed nodes in the resolved prompt",
        { nodeIds: leakedBypassNodeIds },
      );
    }
    // An activated loader missing here would silently ignore the selected model.
    const missingActivatedNodeIds = appliedActivateExecutionIds.filter(
      (executionId) =>
        !Object.prototype.hasOwnProperty.call(resolved.output, executionId) &&
        !promptNodeIds.some((promptNodeId) =>
          promptNodeId.startsWith(`${executionId}${EXECUTION_ID_SEPARATOR}`),
        ),
    );
    if (missingActivatedNodeIds.length > 0) {
      throw new BridgeRuntimeError(
        "activation-verification-failed",
        "ComfyUI dropped nodes this prompt activated; nothing they feed reaches an output",
        { nodeIds: missingActivatedNodeIds },
      );
    }
    const workflowExtra = { ...resolved.workflow.extra };
    if (hadPromptGraphNonce) {
      workflowExtra[PROMPT_GRAPH_NONCE_KEY] = previousPromptGraphNonce;
    } else {
      delete workflowExtra[PROMPT_GRAPH_NONCE_KEY];
    }
    return {
      output: resolved.output,
      workflow: {
        ...resolved.workflow,
        extra: workflowExtra,
      },
    };
  }

  // Prompt resolution is a critical section over shared ComfyUI state, not a
  // pure function of its temporary graph: it shadows `app.rootGraph` for the
  // synchronous `graphToPrompt` call, and its widget overrides land in the
  // widget store the live editor reads. Nesting two of those save/restore pairs
  // leaves the loser's value installed — an override stranded on the editor's
  // widget, or `app.rootGraph` still pointing at a discarded clone. Requests
  // arrive concurrently (each `handleMessage` runs its handler immediately), so
  // resolutions are queued rather than assumed to be serial upstream.
  let promptResolutionLock = Promise.resolve();

  function resolvePrompt(payload) {
    const run = promptResolutionLock.then(
      () => resolvePromptExclusive(payload),
      () => resolvePromptExclusive(payload),
    );
    promptResolutionLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function toGraphPosition(clientX, clientY) {
    try {
      if (typeof app.clientPosToCanvasPos === "function") {
        const converted = app.clientPosToCanvasPos([clientX, clientY]);
        if (
          Array.isArray(converted) &&
          Number.isFinite(converted[0]) &&
          Number.isFinite(converted[1])
        ) {
          return [converted[0], converted[1]];
        }
      }
    } catch {
      // Fall through to the manual DragAndScale conversion below.
    }
    const canvasElement = app.canvas?.canvas;
    const dragAndScale = app.canvas?.ds;
    if (typeof canvasElement?.getBoundingClientRect !== "function" || !dragAndScale) {
      throw new BridgeRuntimeError("canvas-unavailable", "ComfyUI canvas is unavailable");
    }
    const rect = canvasElement.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    if (typeof dragAndScale.convertOffsetToCanvas === "function") {
      const converted = dragAndScale.convertOffsetToCanvas([offsetX, offsetY]);
      if (
        Array.isArray(converted) &&
        Number.isFinite(converted[0]) &&
        Number.isFinite(converted[1])
      ) {
        return [converted[0], converted[1]];
      }
    }
    const scale =
      typeof dragAndScale.scale === "number" && dragAndScale.scale > 0
        ? dragAndScale.scale
        : 1;
    const offset = Array.isArray(dragAndScale.offset) ? dragAndScale.offset : [0, 0];
    return [offsetX / scale - (offset[0] ?? 0), offsetY / scale - (offset[1] ?? 0)];
  }

  function applyLoaderFilename(node, widget, filename) {
    // Loader combos list the input directory; a freshly staged file may not be
    // in the list yet, so append it before selecting (matching ComfyUI's own
    // upload widget behaviour). Prompt validation re-lists the directory, so a
    // stale combo list is cosmetic only.
    const values = widget.options?.values;
    if (Array.isArray(values) && !values.includes(filename)) {
      values.push(filename);
    }
    widget.value = filename;
    try {
      widget.callback?.(filename, app.canvas, node);
    } catch (error) {
      console.warn("[vlo-bridge] loader widget callback failed:", error);
    }
    node.setDirtyCanvas?.(true, true);
  }

  // Duck-typed rather than `instanceof File`: the file arrives by structured
  // clone, and `slice` is the Blob method every environment implements.
  function isFileLike(value) {
    return (
      isRecord(value) &&
      typeof value.name === "string" &&
      typeof value.size === "number" &&
      typeof value.slice === "function"
    );
  }

  /**
   * Loaders already know how to take a dropped file: core nodes install
   * `onDragDrop` through ComfyUI's `useNodeDragAndDrop`, and VHS installs its
   * own. Both read `dataTransfer.files` and gate on `types.includes("Files")`,
   * which `items.add(file)` sets.
   */
  function makeFileDropEvent(file, clientX, clientY) {
    const DataTransferCtor = windowObject.DataTransfer;
    if (typeof DataTransferCtor !== "function") return null;
    let dataTransfer;
    try {
      dataTransfer = new DataTransferCtor();
      dataTransfer.items.add(file);
    } catch {
      return null;
    }
    const DragEventCtor = windowObject.DragEvent;
    if (typeof DragEventCtor === "function") {
      try {
        return new DragEventCtor("drop", {
          dataTransfer,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        });
      } catch {
        // Fall through to the plain event object below.
      }
    }
    return {
      type: "drop",
      dataTransfer,
      clientX,
      clientY,
      preventDefault() {},
      stopPropagation() {},
    };
  }

  function widgetValues(node) {
    const values = new Map();
    if (!Array.isArray(node?.widgets)) return values;
    for (const widget of node.widgets) {
      if (widget && typeof widget.name === "string") {
        values.set(widget.name, widget.value);
      }
    }
    return values;
  }

  /** Whether the drop left a usable value behind. ComfyUI's uploader reports
   * completion by assigning the loader widget, so a changed non-empty widget is
   * the observable proof that the node took the file. */
  function tookFile(node, before) {
    if (!Array.isArray(node?.widgets)) return false;
    return node.widgets.some((widget) => {
      if (!widget || typeof widget.name !== "string") return false;
      const value = widget.value;
      if (value === null || value === undefined || value === "") return false;
      return value !== before.get(widget.name);
    });
  }

  /** Offers the file to the node's own drop handler. Nodes self-police by
   * media type and answer false when the file is not for them. */
  async function offerFileToNode(node, file, clientX, clientY) {
    if (typeof node?.onDragDrop !== "function") return false;
    const event = makeFileDropEvent(file, clientX, clientY);
    if (!event) return false;
    // ComfyUI's uploader refuses re-entrant drops (it toasts and returns no
    // paths, still answering true). Uploading around it would race whichever
    // upload finishes last into the widget.
    if (node.isUploading === true) {
      throw new BridgeRuntimeError(
        "upload-in-progress",
        "This node is still uploading a file; wait for it to finish",
      );
    }
    const before = widgetValues(node);
    try {
      // `true` only means the handler claimed the event: ComfyUI returns it
      // after awaiting an upload whose backend failures it swallows into a
      // toast. Only the widget changing proves the file actually landed.
      if ((await node.onDragDrop(event)) !== true) return false;
    } catch (error) {
      console.warn("[vlo-bridge] node onDragDrop failed:", error);
      return false;
    }
    return tookFile(node, before);
  }

  /** Fallback for loaders with no drop handler: stage the file the same way
   * ComfyUI's own upload widgets do, then point the widget at it. */
  async function uploadToComfyInput(file) {
    const FormDataCtor = windowObject.FormData ?? globalThis.FormData;
    if (typeof FormDataCtor !== "function" || typeof api?.fetchApi !== "function") {
      throw new BridgeRuntimeError(
        "upload-unavailable",
        "ComfyUI did not expose an upload endpoint for this drop",
      );
    }
    const body = new FormDataCtor();
    body.append("image", file, file.name);
    body.append("type", "input");
    const AbortSignalCtor = windowObject.AbortSignal ?? globalThis.AbortSignal;
    const signal =
      typeof AbortSignalCtor?.timeout === "function"
        ? AbortSignalCtor.timeout(UPLOAD_TIMEOUT_MS)
        : null;
    let response;
    try {
      response = await api.fetchApi("/upload/image", {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new BridgeRuntimeError(
        "upload-failed",
        `ComfyUI could not stage the dropped file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response?.ok) {
      throw new BridgeRuntimeError(
        "upload-failed",
        `ComfyUI rejected the dropped file (${response?.status ?? "no response"})`,
      );
    }
    const uploaded = await response.json();
    const name = typeof uploaded?.name === "string" ? uploaded.name : null;
    if (!name) {
      throw new BridgeRuntimeError(
        "upload-failed",
        "ComfyUI upload returned no filename",
      );
    }
    const subfolder =
      typeof uploaded?.subfolder === "string" ? uploaded.subfolder : "";
    return subfolder ? `${subfolder}/${name}` : name;
  }

  /** Node handler first, bridge-side upload second. Returns whether the node
   * took the file. */
  async function deliverFileToNode(node, widgetName, file, clientX, clientY) {
    if (await offerFileToNode(node, file, clientX, clientY)) return true;
    const widget =
      typeof widgetName === "string" ? findNodeWidget(node, widgetName) : null;
    if (!widget) return false;
    applyLoaderFilename(node, widget, await uploadToComfyInput(file));
    return true;
  }

  async function dropAsset(payload) {
    if (!(await waitForAppReady())) {
      throw new BridgeRuntimeError("app-not-ready", "ComfyUI is not ready");
    }
    const clientX = Number(payload?.clientX);
    const clientY = Number(payload?.clientY);
    const file = payload?.file;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !isFileLike(file)) {
      throw new BridgeRuntimeError(
        "invalid-payload",
        "drop-asset requires clientX, clientY and a file",
      );
    }
    const targets = Array.isArray(payload?.targets)
      ? payload.targets.filter(isRecord)
      : [];
    const create = isRecord(payload?.create) ? payload.create : null;
    // Drops land in the graph currently in view (which may be a subgraph).
    const graph = app.canvas?.graph ?? getRootGraph();
    if (!graph || typeof graph.add !== "function") {
      throw new BridgeRuntimeError("workflow-unavailable", "ComfyUI graph is unavailable");
    }
    const position = toGraphPosition(clientX, clientY);

    const hitNode =
      typeof graph.getNodeOnPos === "function"
        ? graph.getNodeOnPos(position[0], position[1])
        : null;
    if (hitNode) {
      const target = targets.find(
        (candidate) => candidate.classType === hitNode.type,
      );
      // The guard runs before the node sees the file: a memory loader's own
      // drop handler would otherwise set the widget behind it.
      if (typeof target?.requiresTruthyWidget === "string") {
        const guard = findNodeWidget(hitNode, target.requiresTruthyWidget);
        if (!isTruthyWidgetValue(guard?.value)) {
          throw new BridgeRuntimeError(
            "memory-loader-active",
            "This loader reads media from memory; enable its disable_in_memory option to drop staged files onto it",
          );
        }
      }
      // Offered to every node under the pointer, not only mapped class types —
      // any loader implementing the drop contract can take the file, and one
      // that cannot answers false and leaves the drop to the create path.
      if (await deliverFileToNode(hitNode, target?.widget, file, clientX, clientY)) {
        handleGraphChanged();
        return {
          action: "updated",
          nodeId: String(hitNode.id),
          classType: String(hitNode.type ?? ""),
        };
      }
    }

    if (
      !create ||
      typeof create.classType !== "string" ||
      typeof create.widget !== "string"
    ) {
      throw new BridgeRuntimeError(
        "drop-unsupported",
        "No compatible loader node type is available for this asset",
      );
    }
    const liteGraph = windowObject.LiteGraph;
    if (typeof liteGraph?.createNode !== "function") {
      throw new BridgeRuntimeError(
        "node-create-unavailable",
        "ComfyUI did not expose LiteGraph.createNode",
      );
    }
    const node = liteGraph.createNode(create.classType);
    if (!node) {
      throw new BridgeRuntimeError(
        "node-create-failed",
        `ComfyUI could not create a ${create.classType} node`,
      );
    }
    const width =
      Array.isArray(node.size) && Number.isFinite(node.size[0]) ? node.size[0] : 0;
    node.pos = [position[0] - width / 2, position[1]];
    graph.add(node);
    try {
      if (!(await deliverFileToNode(node, create.widget, file, clientX, clientY))) {
        throw new BridgeRuntimeError(
          "drop-unsupported",
          `A ${create.classType} node did not accept the dropped file`,
        );
      }
    } catch (error) {
      // Leaving an empty loader behind would look like the drop half-worked.
      graph.remove?.(node);
      handleGraphChanged();
      throw error;
    }
    handleGraphChanged();
    return {
      action: "created",
      nodeId: String(node.id),
      classType: create.classType,
    };
  }

  const handlers = {
    health: async () => ({
      appReady: isAppReady(),
      backendConnected: isBackendConnected(),
    }),
    "read-active": async () => readActive(),
    "read-pending-warnings": async () => readWarnings(getActiveWorkflow(), false),
    "inject-workflow": injectWorkflow,
    "resolve-prompt": resolvePrompt,
    "drop-asset": dropAsset,
    "refresh-missing-models": async () => {
      if (typeof app?.refreshMissingModels !== "function") return { refreshed: false };
      await app.refreshMissingModels({ silent: true });
      return { refreshed: true };
    },
  };

  async function handleMessage(event) {
    if (
      stopped ||
      event.source !== windowObject.parent ||
      event.origin !== windowObject.location.origin ||
      !isRecord(event.data) ||
      event.data.protocol !== BRIDGE_PROTOCOL
    ) {
      return;
    }
    const data = event.data;
    if (data.type === "hello") {
      if (
        data.version !== BRIDGE_VERSION ||
        typeof data.channelId !== "string" ||
        !data.channelId
      ) {
        return;
      }
      activeChannelId = data.channelId;
      bridgeReady = false;
      if (!announceReady()) {
        // Tell the parent the document is alive but ComfyUI is still booting,
        // so it waits instead of reloading the app out from under itself.
        post({ type: "booting" });
        void announceWhenReady();
      }
      return;
    }
    if (
      data.type !== "request" ||
      data.version !== BRIDGE_VERSION ||
      data.channelId !== activeChannelId ||
      typeof data.requestId !== "string" ||
      typeof data.method !== "string"
    ) {
      return;
    }

    const handler = handlers[data.method];
    if (!handler) {
      post({
        type: "response",
        requestId: data.requestId,
        ok: false,
        error: { code: "unknown-method", message: `Unknown bridge method: ${data.method}` },
      });
      return;
    }
    try {
      const result = await handler(data.payload);
      post({ type: "response", requestId: data.requestId, ok: true, result });
    } catch (error) {
      post({
        type: "response",
        requestId: data.requestId,
        ok: false,
        error: {
          code: error instanceof BridgeRuntimeError ? error.code : "internal-error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof BridgeRuntimeError && error.details !== undefined
            ? { details: error.details }
            : {}),
        },
      });
    }
  }

  function pushGraphChanged() {
    graphChangedTimer = null;
    const snapshot = readActive();
    if (snapshot) post({ type: "event", event: "graph-changed", data: snapshot });
  }

  function handleGraphChanged() {
    incrementActiveRevision();
    if (graphChangedTimer !== null) windowObject.clearTimeout(graphChangedTimer);
    graphChangedTimer = windowObject.setTimeout(pushGraphChanged, GRAPH_CHANGED_DEBOUNCE_MS);
  }

  function pushHealthChanged() {
    post({
      type: "event",
      event: "health-changed",
      data: { appReady: isAppReady(), backendConnected: isBackendConnected() },
    });
  }

  // In-editor generation observation. ComfyUI unicasts a submitting client's
  // execution events to it, so as the iframe's own client we see exactly the
  // prompts queued from inside the editor (and nothing vlo submitted, whose
  // events go to the backend monitor's client_id). We forward them so the
  // parent can adopt the run as a delivery. A progress/terminal event can be
  // the first event after a ComfyUI socket blip, so it implicitly starts an
  // unknown prompt rather than depending on execution_start being lossless.
  const observedPromptIds = new Set();
  const finishedPromptIds = new Set();
  const pendingIframeGenerations = new Map();

  function bufferIframeGeneration(data) {
    let pending = pendingIframeGenerations.get(data.promptId);
    if (!pending) {
      if (pendingIframeGenerations.size >= MAX_PENDING_IFRAME_GENERATIONS) {
        const oldestPromptId = pendingIframeGenerations.keys().next().value;
        pendingIframeGenerations.delete(oldestPromptId);
      }
      pending = { started: null, progress: null, finished: null };
      pendingIframeGenerations.set(data.promptId, pending);
    }
    pending[data.phase] = data;
  }

  function postIframeGeneration(data) {
    if (!activeChannelId || !bridgeReady) {
      bufferIframeGeneration(data);
      return;
    }
    post({ type: "event", event: "iframe-generation", data });
  }

  function flushPendingIframeGenerationEvents() {
    const pending = [...pendingIframeGenerations.values()];
    pendingIframeGenerations.clear();
    for (const generation of pending) {
      for (const data of [
        generation.started,
        generation.progress,
        generation.finished,
      ]) {
        if (data) postIframeGeneration(data);
      }
    }
  }

  function observePrompt(promptId) {
    if (finishedPromptIds.has(promptId)) return false;
    if (observedPromptIds.has(promptId)) return true;
    observedPromptIds.add(promptId);
    postIframeGeneration({ promptId, phase: "started" });
    return true;
  }

  function rememberFinishedPrompt(promptId) {
    if (finishedPromptIds.size >= MAX_PENDING_IFRAME_GENERATIONS) {
      const oldestPromptId = finishedPromptIds.values().next().value;
      finishedPromptIds.delete(oldestPromptId);
    }
    finishedPromptIds.add(promptId);
  }

  function handleExecutionStart(event) {
    const promptId = event?.detail?.prompt_id;
    if (typeof promptId !== "string" || !promptId) return;
    finishedPromptIds.delete(promptId);
    observePrompt(promptId);
  }

  function handleExecutionProgress(event) {
    const detail = event?.detail;
    const promptId = detail?.prompt_id;
    if (typeof promptId !== "string" || !promptId) return;
    if (!observePrompt(promptId)) return;
    postIframeGeneration({
      promptId,
      phase: "progress",
      value: typeof detail.value === "number" ? detail.value : null,
      max: typeof detail.max === "number" ? detail.max : null,
      node: typeof detail.node === "string" ? detail.node : null,
    });
  }

  function handleExecutionEnd(event) {
    const promptId = event?.detail?.prompt_id;
    if (typeof promptId !== "string" || !promptId) return;
    if (!observePrompt(promptId)) return;
    observedPromptIds.delete(promptId);
    rememberFinishedPrompt(promptId);
    postIframeGeneration({ promptId, phase: "finished" });
  }

  windowObject.addEventListener("message", handleMessage);
  api?.addEventListener?.("graphChanged", handleGraphChanged);
  api?.addEventListener?.("status", pushHealthChanged);
  api?.addEventListener?.("reconnected", pushHealthChanged);
  api?.addEventListener?.("execution_start", handleExecutionStart);
  api?.addEventListener?.("progress", handleExecutionProgress);
  api?.addEventListener?.("execution_success", handleExecutionEnd);
  api?.addEventListener?.("execution_error", handleExecutionEnd);
  api?.addEventListener?.("execution_interrupted", handleExecutionEnd);

  return {
    stop() {
      stopped = true;
      activeChannelId = null;
      bridgeReady = false;
      if (graphChangedTimer !== null) windowObject.clearTimeout(graphChangedTimer);
      windowObject.removeEventListener("message", handleMessage);
      api?.removeEventListener?.("graphChanged", handleGraphChanged);
      api?.removeEventListener?.("status", pushHealthChanged);
      api?.removeEventListener?.("reconnected", pushHealthChanged);
      api?.removeEventListener?.("execution_start", handleExecutionStart);
      api?.removeEventListener?.("progress", handleExecutionProgress);
      api?.removeEventListener?.("execution_success", handleExecutionEnd);
      api?.removeEventListener?.("execution_error", handleExecutionEnd);
      api?.removeEventListener?.("execution_interrupted", handleExecutionEnd);
    },
    readActive,
  };
}
