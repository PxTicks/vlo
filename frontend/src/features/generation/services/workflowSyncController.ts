import type {
  WorkflowReadResult,
  WorkflowWarningSummary,
} from "./workflowBridge";
import { buildWorkflowResultFromGraphData } from "./workflowBridge";
import {
  IframeBridgeError,
  iframeBridge,
  type BridgeWorkflowSnapshot,
} from "./iframeBridgeClient";
import type { InputNodeMap } from "../constants/inputNodeMap";

const APP_READY_TIMEOUT_MS = 3000;
const READ_RETRY_POLL_MS = 100;
const READ_RETRY_TIMEOUT_MS = 3000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export type ShouldAbort = () => boolean;

function buildWorkflowResult(
  snapshot: BridgeWorkflowSnapshot,
  inputNodeMap?: InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
): WorkflowReadResult {
  return buildWorkflowResultFromGraphData(
    snapshot.graphData,
    snapshot.filename,
    {
      inputNodeMap,
      objectInfo,
      workflowInstanceId: snapshot.workflowInstanceId,
      revision: snapshot.revision,
    },
  );
}

export async function waitForAppReady(
  _iframe: HTMLIFrameElement,
  shouldAbort: ShouldAbort,
  timeoutMs = APP_READY_TIMEOUT_MS,
): Promise<boolean> {
  return iframeBridge.waitForReady(timeoutMs, shouldAbort);
}

export async function readWorkflowWithRetry(
  _iframe: HTMLIFrameElement,
  shouldAbort: ShouldAbort,
  timeoutMs = READ_RETRY_TIMEOUT_MS,
  inputNodeMap?: InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
): Promise<WorkflowReadResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) return null;
    try {
      const snapshot = await iframeBridge.readActive();
      if (snapshot) return buildWorkflowResult(snapshot, inputNodeMap, objectInfo);
    } catch (error) {
      if (
        error instanceof IframeBridgeError &&
        (error.code === "incompatible" || error.code === "not-bound")
      ) {
        throw error;
      }
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
      reason: "iframe bridge not ready",
      warnings: null,
      workflowResult: null,
    };
  }

  try {
    const result = await iframeBridge.injectWorkflow(graphData, workflowId);
    if (shouldAbort()) {
      return {
        ok: false,
        deferred: true,
        reason: "workflow load aborted",
        warnings: result.warnings,
        workflowResult: null,
      };
    }
    return {
      ok: true,
      deferred: false,
      reason: null,
      warnings: result.warnings,
      workflowResult: buildWorkflowResult(
        result.snapshot,
        inputNodeMap,
        objectInfo,
      ),
    };
  } catch (error) {
    if (error instanceof IframeBridgeError) {
      const terminal =
        error.code === "incompatible" ||
        error.code === "invalid-response" ||
        error.code === "clone-unavailable";
      return {
        ok: false,
        deferred: !terminal,
        reason: error.message,
        warnings: null,
        workflowResult: null,
      };
    }
    throw error;
  }
}
