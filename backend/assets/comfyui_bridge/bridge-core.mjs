export const BRIDGE_PROTOCOL = "vlo-bridge";
export const BRIDGE_VERSION = 2;
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
]);

const APP_READY_POLL_MS = 100;
const APP_READY_TIMEOUT_MS = 15_000;
const WORKFLOW_ACTIVE_TIMEOUT_MS = 3_000;
const WARNING_CAPTURE_POLL_MS = 50;
const WARNING_CAPTURE_TIMEOUT_MS = 1_000;
const GRAPH_CHANGED_DEBOUNCE_MS = 300;

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

function getNodeByExternalId(graph, rawId) {
  let node = graph.getNodeById(rawId);
  if (!node && typeof rawId === "string" && /^-?\d+$/.test(rawId)) {
    node = graph.getNodeById(Number(rawId));
  }
  return node;
}

function applyOverridesToGraph(graph, bypassNodeIds, widgetOverrides) {
  for (const nodeId of bypassNodeIds) {
    const node = getNodeByExternalId(graph, nodeId);
    if (node) node.mode = 4;
  }
  for (const override of widgetOverrides) {
    if (!isRecord(override) || typeof override.widget !== "string") continue;
    const node = getNodeByExternalId(graph, override.node_id);
    const widget = node?.widgets?.find((candidate) => candidate.name === override.widget);
    if (widget) widget.value = override.value;
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

  let activeChannelId = null;
  let workflowCounter = 0;
  let graphChangedTimer = null;
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
    post({
      type: "ready",
      capabilities: BRIDGE_CAPABILITIES,
    });
    return true;
  }

  async function announceWhenReady() {
    if (await waitForAppReady()) announceReady();
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

  async function resolvePrompt(payload) {
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

    applyOverridesToGraph(
      tempGraph,
      Array.isArray(payload?.bypassNodeIds) ? payload.bypassNodeIds : [],
      Array.isArray(payload?.widgetOverrides) ? payload.widgetOverrides : [],
    );

    let resolved;
    try {
      resolved = await app.graphToPrompt(tempGraph);
    } catch (error) {
      throw new BridgeRuntimeError(
        "graph-to-prompt-failed",
        "ComfyUI could not resolve the temporary graph",
        { reason: error instanceof Error ? error.message : String(error) },
      );
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
    return {
      output: resolved.output,
      workflow: isRecord(resolved.workflow) ? resolved.workflow : {},
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
      if (!announceReady()) void announceWhenReady();
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

  windowObject.addEventListener("message", handleMessage);
  api?.addEventListener?.("graphChanged", handleGraphChanged);
  api?.addEventListener?.("status", pushHealthChanged);
  api?.addEventListener?.("reconnected", pushHealthChanged);

  return {
    stop() {
      stopped = true;
      activeChannelId = null;
      if (graphChangedTimer !== null) windowObject.clearTimeout(graphChangedTimer);
      windowObject.removeEventListener("message", handleMessage);
      api?.removeEventListener?.("graphChanged", handleGraphChanged);
      api?.removeEventListener?.("status", pushHealthChanged);
      api?.removeEventListener?.("reconnected", pushHealthChanged);
    },
    readActive,
  };
}
