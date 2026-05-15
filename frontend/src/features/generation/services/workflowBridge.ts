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
import { haveMatchingWorkflowNodes } from "../utils/workflowNodeSignature";
import { canonicalizeWorkflowClassType } from "../utils/workflowClassTypes";

/**
 * Graph-based workflow bridge for the live editor UI.
 *
 * This module is intentionally limited to visual-graph data for workflow
 * synchronization and display. It does not call `app.graphToPrompt()` to
 * derive display state. Deprecated API-shaped iframe readers live in
 * `deprecatedApiWorkflowBridge.ts`.
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

function collectLinkedInputNames(node: Record<string, unknown>): Set<string> {
  const linked = new Set<string>();
  const rawInputs = Array.isArray(node.inputs) ? node.inputs : [];
  for (const entry of rawInputs) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    if (typeof entry.link === "number") linked.add(entry.name);
  }
  return linked;
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
 * The return shape mirrors the API-workflow parser from
 * `apiWorkflowInputs.ts` so call sites can use either source
 * interchangeably.
 *
 * NOTE: This is for input discovery only. It is NEVER a substitute for
 * `app.graphToPrompt()` and MUST NEVER be the source of an execution
 * payload — see `captureSubmittedWorkflow` in `executionStoreState.ts`,
 * which is the single source of truth for workflows actually submitted to
 * ComfyUI.
 */
export function parseInputsFromGraphData(
  graphData: Record<string, unknown>,
  options: {
    inputNodeMap?: InputNodeMap | null;
    objectInfo?: Record<string, unknown> | null;
  } = {},
): WorkflowInput[] {
  const rawNodes = Array.isArray(graphData.nodes) ? graphData.nodes : [];
  // Iterate in numeric-id order so input ordering does not depend on the
  // author's visual node placement. Pre-`df8ea99` the workflow was projected
  // through an API-shape object keyed by node-id strings, which JS iterates
  // numerically — code downstream (group ordering, sortConditioningInputs)
  // implicitly relies on that.
  const nodes = [...rawNodes].sort((left, right) => {
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
  const nodeMap = options.inputNodeMap ?? INPUT_NODE_MAP;
  const objectInfo = options.objectInfo ?? null;
  const inputs: WorkflowInput[] = [];

  for (const node of nodes) {
    if (!isRecord(node) || node.id == null || typeof node.type !== "string") {
      continue;
    }
    if (node.mode === 2 || node.mode === 4) continue;
    const rawClassType = node.type.trim();
    const classType =
      canonicalizeWorkflowClassType(rawClassType) ?? rawClassType;
    if (!classType) continue;

    const mappings = resolveInputNodeMappings(nodeMap, classType);
    if (mappings.length === 0) continue;

    const nodeId = String(node.id);
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
    const linkedParams = collectLinkedInputNames(node);

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

  return inputs;
}

export function buildWorkflowResultFromGraphData(
  graphData: Record<string, unknown>,
  filename: string | null,
  options: {
    inputNodeMap?: InputNodeMap | null;
    objectInfo?: Record<string, unknown> | null;
  } = {},
): WorkflowReadResult {
  // No API-shape projection — `workflow` is null. Anything that genuinely
  // needs an API workflow (i.e. the submission payload) must obtain it via
  // `app.graphToPrompt()`, never through this path.
  return {
    workflow: null,
    graphData,
    inputs: parseInputsFromGraphData(graphData, options),
    filename,
  };
}

// ---------------------------------------------------------------------------
// Iframe bridge
// ---------------------------------------------------------------------------

type WorkflowTab = {
  path?: string;
  key?: string;
  filename?: string;
  fullFilename?: string;
  isModified?: boolean;
  pendingWarnings?: unknown;
  activeState?: Record<string, unknown> | null;
};

interface ComfyUIWorkflowApi {
  workflows?: WorkflowTab[];
  openWorkflows?: WorkflowTab[];
  activeWorkflow?: WorkflowTab | null;
  closeWorkflow?: (wf: WorkflowTab) => Promise<void>;
}

interface ComfyUIApp {
  handleFile?: (
    file: File,
    openSource?: string,
    options?: { deferWarnings?: boolean },
  ) => Promise<void>;
  canvas?: unknown;
  extensionManager?: {
    workflow?: ComfyUIWorkflowApi;
    spinner?: boolean;
  };
  api?: {
    socket?: {
      readyState?: number;
      OPEN?: number;
      connected?: boolean;
    };
  };
}

type ComfyUIWindow = Window & {
  app?: ComfyUIApp;
  api?: {
    socket?: {
      readyState?: number;
      OPEN?: number;
      connected?: boolean;
    };
  };
};

export interface WorkflowWarningSummary {
  missingNodeTypes: string[];
  missingModels: string[];
}

export interface WorkflowReadResult {
  // Active graph-sync helpers in this module always leave this as `null`.
  // Non-null values come only from deprecated API-shaped iframe readers.
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown>;
  inputs: WorkflowInput[];
  filename: string | null;
}

export interface ActiveWorkflowReadResult {
  graphData: Record<string, unknown>;
  filename: string | null;
  isModified: boolean;
}

export interface LoadWorkflowIntoIframeOptions {
  deferWarnings?: boolean;
  capturePendingWarnings?: boolean;
}

export interface LoadWorkflowIntoIframeResult {
  ok: boolean;
  warnings: WorkflowWarningSummary | null;
}

const WARN_LOG_PREFIX = "[workflowBridge][warnings]";

function logWarningDebug(message: string, details?: unknown) {
  if (!import.meta.env.DEV) return;
  if (details === undefined) {
    console.info(`${WARN_LOG_PREFIX} ${message}`);
    return;
  }
  console.info(`${WARN_LOG_PREFIX} ${message}`, details);
}

function summarizeWorkflowTab(wf: WorkflowTab | null | undefined) {
  if (!wf) return null;
  const pendingWarningsRaw =
    "pendingWarnings" in wf
      ? wf.pendingWarnings
      : "__missing_pendingWarnings_field__";

  return {
    path: typeof wf.path === "string" ? wf.path : null,
    filename: typeof wf.filename === "string" ? wf.filename : null,
    hasPendingWarningsField: "pendingWarnings" in wf,
    pendingWarningsType:
      pendingWarningsRaw === null ? "null" : typeof pendingWarningsRaw,
    pendingWarningsKeys: isRecord(pendingWarningsRaw)
      ? Object.keys(pendingWarningsRaw)
      : [],
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

function normalizeWorkflowFilename(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const segments = trimmed.split("/").filter(Boolean);
  const filename = segments.at(-1)?.trim() ?? trimmed;
  return filename.length > 0 ? filename : null;
}

function resolveWorkflowTabFilename(
  workflow: WorkflowTab | null | undefined,
): string | null {
  if (!workflow) return null;

  const directCandidates = [
    workflow.filename,
    workflow.fullFilename,
    workflow.key,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeWorkflowFilename(candidate);
    if (normalized) return normalized;
  }

  if (typeof workflow.path === "string") {
    const normalized = normalizeWorkflowFilename(workflow.path);
    if (normalized) return normalized;
  }

  return null;
}

function getActiveWorkflowGraphData(
  activeWorkflow: WorkflowTab | null | undefined,
): Record<string, unknown> | null {
  if (!activeWorkflow) return null;
  if (!isRecord(activeWorkflow.activeState)) return null;
  return cloneRecord(activeWorkflow.activeState);
}

function getWorkflowTabs(
  workflowApi: ComfyUIWorkflowApi | null | undefined,
): WorkflowTab[] {
  if (!workflowApi) {
    return [];
  }

  const openWorkflows =
    workflowApi.workflows ?? workflowApi.openWorkflows ?? [];
  const activeWorkflow = workflowApi.activeWorkflow ?? null;

  if (!activeWorkflow || openWorkflows.includes(activeWorkflow)) {
    return openWorkflows;
  }

  return [...openWorkflows, activeWorkflow];
}

function getWorkflowTabMatchScore(
  workflow: WorkflowTab | null | undefined,
  expectedGraphData: Record<string, unknown>,
  expectedWorkflowId: string,
): number {
  if (!workflow) {
    return 0;
  }

  let score = 0;
  const expectedFilename = normalizeWorkflowFilename(expectedWorkflowId);
  const actualFilename = resolveWorkflowTabFilename(workflow);
  if (
    expectedFilename &&
    actualFilename &&
    expectedFilename === actualFilename
  ) {
    score += 2;
  }

  if (
    haveMatchingWorkflowNodes(
      expectedGraphData,
      getActiveWorkflowGraphData(workflow),
    )
  ) {
    score += 1;
  }

  return score;
}

function findMatchingWorkflowTab(
  workflowApi: ComfyUIWorkflowApi | null | undefined,
  expectedGraphData: Record<string, unknown>,
  expectedWorkflowId: string,
): WorkflowTab | null {
  let bestMatch: WorkflowTab | null = null;
  let bestScore = 0;

  for (const workflow of getWorkflowTabs(workflowApi)) {
    const score = getWorkflowTabMatchScore(
      workflow,
      expectedGraphData,
      expectedWorkflowId,
    );
    if (score <= bestScore) {
      continue;
    }
    bestMatch = workflow;
    bestScore = score;
  }

  return bestMatch;
}

export function readActiveWorkflowFromIframe(
  iframe: HTMLIFrameElement,
): ActiveWorkflowReadResult | null {
  try {
    const activeWorkflow = getIframeWorkflowApi(iframe)?.activeWorkflow ?? null;
    const graphData = getActiveWorkflowGraphData(activeWorkflow);
    if (!activeWorkflow || !graphData) {
      return null;
    }

    return {
      graphData,
      filename: resolveWorkflowTabFilename(activeWorkflow),
      isModified: activeWorkflow.isModified === true,
    };
  } catch (err) {
    console.warn("[workflowBridge] readActiveWorkflowFromIframe failed:", err);
    return null;
  }
}

function toUnique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractMissingNodeTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const types = value
    .map((entry) => {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      if (!isRecord(entry)) return null;

      if (typeof entry.type === "string" && entry.type.trim().length > 0) {
        return entry.type.trim();
      }
      if (
        typeof entry.class_type === "string" &&
        entry.class_type.trim().length > 0
      ) {
        return entry.class_type.trim();
      }
      return null;
    })
    .filter((type): type is string => type !== null);

  return toUnique(types);
}

function extractMissingModels(value: unknown): string[] {
  const modelEntries: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value) &&
        (Array.isArray(value.missingModelCandidates) ||
          Array.isArray(value.missingModels))
      ? (value.missingModelCandidates ?? value.missingModels) as unknown[]
      : [];

  const names = modelEntries
    .map((entry) => {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      if (!isRecord(entry)) return null;

      // ComfyUI's new MissingModelCandidate shape carries an isMissing flag
      // that may be false (installed) or undefined (pending verification).
      // The pipeline already filters to isMissing === true before caching,
      // but defend against stale entries left by interrupted runs.
      if ("isMissing" in entry && entry.isMissing !== true) {
        return null;
      }

      const candidates = [
        entry.name,
        entry.file_name,
        entry.filename,
        entry.url,
        entry.hash,
      ];

      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          return candidate.trim();
        }
      }
      return null;
    })
    .filter((name): name is string => name !== null);

  return toUnique(names);
}

/**
 * Get the workflow API from the ComfyUI iframe.
 * Returns null if the API is not accessible.
 */
function getIframeWorkflowApi(
  iframe: HTMLIFrameElement,
): ComfyUIWorkflowApi | null {
  try {
    const win = iframe.contentWindow as ComfyUIWindow | null;
    return win?.app?.extensionManager?.workflow ?? null;
  } catch {
    return null;
  }
}

function readPendingWarningsFromWorkflow(
  workflow: WorkflowTab | null | undefined,
): WorkflowWarningSummary | null {
  if (!workflow || !isRecord(workflow.pendingWarnings)) {
    return null;
  }

  const missingNodeTypes = extractMissingNodeTypes(
    workflow.pendingWarnings.missingNodeTypes,
  );
  // ComfyUI renamed `missingModels` → `missingModelCandidates` along with
  // a richer candidate shape (see MissingModelCandidate in their
  // `platform/missingModel/types.ts`). Fall back to the old key for older
  // ComfyUI builds.
  const missingModels = extractMissingModels(
    workflow.pendingWarnings.missingModelCandidates ??
      workflow.pendingWarnings.missingModels,
  );

  if (missingNodeTypes.length === 0 && missingModels.length === 0) {
    return null;
  }

  return { missingNodeTypes, missingModels };
}

function clearPendingWarningsFromWorkflow(
  workflow: WorkflowTab | null | undefined,
): boolean {
  if (!workflow || !("pendingWarnings" in workflow)) {
    return false;
  }

  workflow.pendingWarnings = null;
  return true;
}

export function readPendingWarningsFromIframe(
  iframe: HTMLIFrameElement,
): WorkflowWarningSummary | null {
  try {
    const workflowApi = getIframeWorkflowApi(iframe);
    const activeWorkflow = workflowApi?.activeWorkflow ?? null;
    logWarningDebug(
      "active workflow snapshot",
      summarizeWorkflowTab(activeWorkflow),
    );
    if (!activeWorkflow || !isRecord(activeWorkflow.pendingWarnings)) {
      logWarningDebug("no pendingWarnings on active workflow");
      return null;
    }

    const warnings = readPendingWarningsFromWorkflow(activeWorkflow);
    if (!warnings) {
      logWarningDebug(
        "pendingWarnings existed but parsed as empty (no missing nodes/models)",
      );
      return null;
    }

    logWarningDebug("read pendingWarnings", {
      fromWorkflow: summarizeWorkflowTab(activeWorkflow),
      missingNodeTypes: warnings.missingNodeTypes,
      missingModels: warnings.missingModels,
    });
    return warnings;
  } catch (err) {
    console.warn("[workflowBridge] readPendingWarningsFromIframe failed:", err);
    return null;
  }
}

export function clearPendingWarningsFromIframe(
  iframe: HTMLIFrameElement,
): boolean {
  try {
    const workflowApi = getIframeWorkflowApi(iframe);
    const activeWorkflow = workflowApi?.activeWorkflow ?? null;
    if (!activeWorkflow || !("pendingWarnings" in activeWorkflow)) {
      logWarningDebug("clear skipped: no active workflow/pendingWarnings field");
      return false;
    }

    clearPendingWarningsFromWorkflow(activeWorkflow);
    logWarningDebug(
      "cleared activeWorkflow.pendingWarnings",
      summarizeWorkflowTab(activeWorkflow),
    );
    return true;
  } catch (err) {
    console.warn(
      "[workflowBridge] clearPendingWarningsFromIframe failed:",
      err,
    );
    return false;
  }
}

export function readAndClearPendingWarningsFromIframe(
  iframe: HTMLIFrameElement,
): WorkflowWarningSummary | null {
  const warnings = readPendingWarningsFromIframe(iframe);
  if (warnings) {
    clearPendingWarningsFromIframe(iframe);
  }
  return warnings;
}

const WARNING_CAPTURE_POLL_MS = 50;
const WARNING_CAPTURE_TIMEOUT_MS = 4000;

export async function capturePendingWarningsForWorkflowFromIframe(
  iframe: HTMLIFrameElement,
  expectedGraphData: Record<string, unknown>,
  expectedWorkflowId: string,
  timeoutMs = WARNING_CAPTURE_TIMEOUT_MS,
  settleAfterMatchMs = 0,
): Promise<WorkflowWarningSummary | null> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let firstMatchedAt: number | null = null;
  logWarningDebug("capture polling started", {
    timeoutMs,
    expectedWorkflowId,
    settleAfterMatchMs,
  });

  while (Date.now() < deadline) {
    attempts += 1;
    const workflowApi = getIframeWorkflowApi(iframe);
    const matchedWorkflow = findMatchingWorkflowTab(
      workflowApi,
      expectedGraphData,
      expectedWorkflowId,
    );

    if (matchedWorkflow) {
      const warnings = readPendingWarningsFromWorkflow(matchedWorkflow);
      if (warnings) {
        clearPendingWarningsFromWorkflow(matchedWorkflow);
        logWarningDebug("capture polling resolved for matched workflow", {
          attempts,
          matchedWorkflow: summarizeWorkflowTab(matchedWorkflow),
          warnings,
        });
        return warnings;
      }

      firstMatchedAt ??= Date.now();
      if (Date.now() - firstMatchedAt >= settleAfterMatchMs) {
        logWarningDebug("capture polling resolved for matched workflow", {
          attempts,
          matchedWorkflow: summarizeWorkflowTab(matchedWorkflow),
          warnings: null,
        });
        return null;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, WARNING_CAPTURE_POLL_MS));
  }

  logWarningDebug("capture polling timed out before target workflow appeared", {
    attempts,
    expectedWorkflowId,
  });
  return null;
}

function resolveActiveWorkflowIndex(
  openWorkflows: WorkflowTab[],
  activeWorkflow: WorkflowTab,
): number {
  const byReference = openWorkflows.findIndex((wf) => wf === activeWorkflow);
  if (byReference >= 0) return byReference;

  const activePath =
    typeof activeWorkflow.path === "string" &&
    activeWorkflow.path.trim().length > 0
      ? activeWorkflow.path
      : null;
  if (activePath) {
    const byPath = openWorkflows.findIndex((wf) => wf.path === activePath);
    if (byPath >= 0) return byPath;
  }

  const activeFilename =
    typeof activeWorkflow.filename === "string" &&
    activeWorkflow.filename.trim().length > 0
      ? activeWorkflow.filename
      : null;
  if (activeFilename) {
    const byFilename = openWorkflows.findIndex(
      (wf) =>
        wf.filename === activeFilename &&
        (activePath === null || wf.path === activePath),
    );
    if (byFilename >= 0) return byFilename;
  }

  return -1;
}

/**
 * Close every workflow tab except the currently active tab.
 *
 * Switching workflows from the UI should end with one active tab. On startup/
 * refresh, ComfyUI can sometimes reuse the current tab instead of creating a
 * new rightmost tab, so "close tabs to left" is not sufficient.
 */
async function closeOtherIframeWorkflows(
  iframe: HTMLIFrameElement,
  expectedGraphData?: Record<string, unknown>,
  expectedWorkflowId?: string,
): Promise<void> {
  try {
    const workflowApi = getIframeWorkflowApi(iframe);
    if (!workflowApi) return;

    const openWorkflows = getWorkflowTabs(workflowApi);
    if (openWorkflows.length <= 1) return;

    const workflowToKeep =
      expectedGraphData && expectedWorkflowId
        ? findMatchingWorkflowTab(
            workflowApi,
            expectedGraphData,
            expectedWorkflowId,
          )
        : null;
    const activeWorkflow = workflowToKeep ?? workflowApi.activeWorkflow;
    if (!activeWorkflow) return;

    const activeIndex = resolveActiveWorkflowIndex(
      openWorkflows,
      activeWorkflow,
    );
    if (activeIndex < 0) return;

    const toClose = openWorkflows.filter((_, index) => index !== activeIndex);
    for (const wf of toClose) {
      if (workflowApi.closeWorkflow) {
        await workflowApi.closeWorkflow(wf);
      }
    }
  } catch (err) {
    console.warn("[workflowBridge] closeOtherIframeWorkflows failed:", err);
  }
}

/**
 * Loads a workflow into the ComfyUI editor inside an iframe via `app.handleFile`.
 * This handles both visual-format and API-format workflows automatically —
 * ComfyUI's own format detection routes to loadGraphData or loadApiJson as needed.
 *
 * After loading, all non-active workflow tabs are closed to prevent proliferation.
 */
export async function loadWorkflowIntoIframe(
  iframe: HTMLIFrameElement,
  workflowData: Record<string, unknown>,
  filename = "workflow.json",
  options: LoadWorkflowIntoIframeOptions = {},
): Promise<LoadWorkflowIntoIframeResult> {
  try {
    const { deferWarnings = true, capturePendingWarnings = false } = options;
    const workflowApi = getIframeWorkflowApi(iframe);
    const openWorkflows =
      workflowApi?.workflows ?? workflowApi?.openWorkflows ?? [];
    logWarningDebug("loadWorkflowIntoIframe start", {
      filename,
      deferWarnings,
      capturePendingWarnings,
      openWorkflowCount: openWorkflows.length,
      activeWorkflow: summarizeWorkflowTab(workflowApi?.activeWorkflow),
    });
    const win = iframe.contentWindow as ComfyUIWindow | null;
    if (!win?.app?.handleFile) return { ok: false, warnings: null };
    logWarningDebug("runtime method shape", {
      handleFileLength:
        typeof win.app.handleFile === "function" ? win.app.handleFile.length : -1,
    });

    const blob = new Blob([JSON.stringify(workflowData)], {
      type: "application/json",
    });
    const file = new File([blob], filename, { type: "application/json" });
    await win.app.handleFile(file, undefined, { deferWarnings });
    logWarningDebug("handleFile resolved", {
      activeWorkflowAfterHandleFile: summarizeWorkflowTab(
        getIframeWorkflowApi(iframe)?.activeWorkflow,
      ),
    });

    let warnings: WorkflowWarningSummary | null = null;
    if (deferWarnings && capturePendingWarnings) {
      warnings = await capturePendingWarningsForWorkflowFromIframe(
        iframe,
        workflowData,
        filename,
        WARNING_CAPTURE_TIMEOUT_MS,
      );
    }
    logWarningDebug("post-load warning capture result", {
      warnings,
    });

    await closeOtherIframeWorkflows(iframe, workflowData, filename);
    logWarningDebug("closeOtherIframeWorkflows resolved");

    return { ok: true, warnings };
  } catch (err) {
    console.warn("[workflowBridge] loadWorkflowIntoIframe failed:", err);
    return { ok: false, warnings: null };
  }
}

/**
 * Checks if the ComfyUI app inside the iframe is ready for workflow
 * injection.
 *
 * The lax check (`handleFile` or `extensionManager.workflow` exists) returned
 * true very early: `app.extensionManager = useWorkspaceStore()` runs in
 * ComfyUI's `App.vue` script setup, before `GraphCanvas.onMounted` has fired
 * `comfyApp.setup()` or `workflowPersistence.initializeWorkflow()`. Injecting
 * `handleFile` during that window races ComfyUI's own initial workflow
 * restore, which can land last and overwrite our inject — exactly the
 * "loaded workflow did not become active" path that drives the deferred
 * retry chain.
 *
 * The gates below cover the full GraphCanvas onMounted sequence:
 *   - `handleFile` present (app instance exists)
 *   - `canvas` present (`comfyApp.setup()` got past LGraphCanvas creation)
 *   - `extensionManager.spinner === false` (onMounted try-block finished —
 *     extensions loaded, nodes registered)
 *   - `extensionManager.workflow.activeWorkflow` truthy
 *     (`workflowPersistence.initializeWorkflow()` ran, so our handleFile
 *     won't race ComfyUI's restore)
 */
export function isIframeAppReady(iframe: HTMLIFrameElement): boolean {
  try {
    const win = iframe.contentWindow as ComfyUIWindow | null;
    const app = win?.app;
    if (!app) return false;
    if (typeof app.handleFile !== "function") return false;
    if (!app.canvas) return false;
    const extensionManager = app.extensionManager;
    if (!extensionManager) return false;
    if (extensionManager.spinner === true) return false;
    if (!extensionManager.workflow?.activeWorkflow) return false;
    return true;
  } catch (err) {
    console.warn("[workflowBridge] isIframeAppReady failed:", err);
    return false;
  }
}

/**
 * Checks whether the ComfyUI iframe appears connected to its backend socket.
 *
 * We use multiple known socket locations because ComfyUI internals vary across
 * versions. If no socket object is exposed, we conservatively treat an
 * initialized app as healthy and let higher-level read polling decide.
 */
export function isIframeBackendConnected(iframe: HTMLIFrameElement): boolean {
  try {
    const win = iframe.contentWindow as ComfyUIWindow | null;
    if (!win) return false;

    const socketCandidates = [win.app?.api?.socket, win.api?.socket].filter(
      Boolean,
    );

    if (socketCandidates.length === 0) {
      return isIframeAppReady(iframe);
    }

    return socketCandidates.some((socket) => {
      if (!socket) return false;

      if (typeof socket.connected === "boolean") {
        return socket.connected;
      }

      if (typeof socket.readyState !== "number") {
        return false;
      }

      const openState =
        typeof socket.OPEN === "number"
          ? socket.OPEN
          : typeof WebSocket?.OPEN === "number"
            ? WebSocket.OPEN
            : 1;

      return socket.readyState === openState;
    });
  } catch (err) {
    console.warn("[workflowBridge] isIframeBackendConnected failed:", err);
    return false;
  }
}
