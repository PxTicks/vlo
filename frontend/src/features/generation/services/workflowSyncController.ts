import type {
  WorkflowReadResult,
  WorkflowWarningSummary,
} from "./workflowBridge";
import {
  buildWorkflowResultFromGraphData,
  isIframeAppReady,
  loadWorkflowIntoIframe,
  readActiveWorkflowFromIframe,
} from "./workflowBridge";
import type { InputNodeMap } from "../constants/inputNodeMap";
import { normalizeWorkflowFilename } from "./workflowFilenames";
import { haveMatchingWorkflowNodes } from "../utils/workflowNodeSignature";

const APP_READY_POLL_MS = 100;
const APP_READY_TIMEOUT_MS = 3000;
const READ_RETRY_POLL_MS = 100;
const READ_RETRY_TIMEOUT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ShouldAbort = () => boolean;

function matchesExpectedWorkflowResult(
  workflowResult: WorkflowReadResult,
  expectedGraphData: Record<string, unknown>,
  expectedWorkflowId: string,
): boolean {
  if (!workflowResult) {
    return false;
  }

  const normalizedExpectedWorkflowId =
    normalizeWorkflowFilename(expectedWorkflowId);
  const normalizedActualWorkflowId = workflowResult.filename
    ? normalizeWorkflowFilename(workflowResult.filename)
    : null;

  if (
    normalizedExpectedWorkflowId &&
    normalizedActualWorkflowId &&
    normalizedExpectedWorkflowId === normalizedActualWorkflowId
  ) {
    return true;
  }

  return (
    haveMatchingWorkflowNodes(expectedGraphData, workflowResult.graphData) ||
    haveMatchingWorkflowNodes(expectedGraphData, workflowResult.workflow)
  );
}

export async function waitForAppReady(
  iframe: HTMLIFrameElement,
  shouldAbort: ShouldAbort,
  timeoutMs = APP_READY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) return false;
    if (isIframeAppReady(iframe)) return true;
    await sleep(APP_READY_POLL_MS);
  }
  return false;
}

export async function readWorkflowWithRetry(
  iframe: HTMLIFrameElement,
  shouldAbort: ShouldAbort,
  timeoutMs = READ_RETRY_TIMEOUT_MS,
  inputNodeMap?: InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
  isAcceptableResult?: (
    result: NonNullable<WorkflowReadResult>,
  ) => boolean,
): Promise<WorkflowReadResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) return null;
    const activeWorkflow = readActiveWorkflowFromIframe(iframe);
    const result = activeWorkflow
      ? buildWorkflowResultFromGraphData(
          activeWorkflow.graphData,
          activeWorkflow.filename,
          {
            inputNodeMap,
            objectInfo,
          },
        )
      : null;
    if (result && (!isAcceptableResult || isAcceptableResult(result))) {
      return result;
    }
    await sleep(READ_RETRY_POLL_MS);
  }
  return null;
}

export interface InjectWorkflowAndReadResult {
  ok: boolean;
  deferred: boolean;
  reason: string | null;
  warnings: WorkflowWarningSummary | null;
  workflowResult: WorkflowReadResult | null;
}

export async function injectWorkflowAndRead(
  iframe: HTMLIFrameElement,
  graphData: Record<string, unknown>,
  workflowId: string,
  shouldAbort: ShouldAbort,
  inputNodeMap?: InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
): Promise<InjectWorkflowAndReadResult> {
  const appReady = await waitForAppReady(iframe, shouldAbort);
  if (!appReady) {
    return {
      ok: false,
      deferred: true,
      reason: "iframe app not ready",
      warnings: null,
      workflowResult: null,
    };
  }

  const loadResult = await loadWorkflowIntoIframe(iframe, graphData, workflowId, {
    deferWarnings: true,
    capturePendingWarnings: true,
  });
  if (shouldAbort()) {
    return {
      ok: false,
      deferred: true,
      reason: "workflow load aborted",
      warnings: loadResult.warnings,
      workflowResult: null,
    };
  }

  const workflowResult = await readWorkflowWithRetry(
    iframe,
    shouldAbort,
    READ_RETRY_TIMEOUT_MS,
    inputNodeMap,
    objectInfo,
    (result) =>
      matchesExpectedWorkflowResult(result, graphData, workflowId),
  );
  if (!workflowResult) {
    return {
      ok: false,
      deferred: true,
      reason: "loaded workflow did not become active",
      warnings: loadResult.warnings,
      workflowResult: null,
    };
  }

  return {
    ok: loadResult.ok,
    deferred: false,
    reason: loadResult.ok ? null : "workflow injection failed",
    warnings: loadResult.warnings,
    workflowResult,
  };
}
