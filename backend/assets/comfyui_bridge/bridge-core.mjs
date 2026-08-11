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

  // Identifies this document to the parent. A reload replaces the runtime but
  // not the iframe element, so the parent cannot otherwise tell an answer from
  // the outgoing document apart from one by the document replacing it.
  const documentId =
    windowObject.crypto?.randomUUID?.() ??
    `document-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let activeChannelId = null;
  let bridgeReady = false;
  let workflowCounter = 0;
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
