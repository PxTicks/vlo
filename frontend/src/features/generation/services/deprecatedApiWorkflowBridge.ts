import type { InputNodeMap } from "../constants/inputNodeMap";
import { isRecord } from "./parsers";
import { parseInputsFromApiWorkflow } from "./apiWorkflowInputs";
import {
  readActiveWorkflowFromIframe,
  type WorkflowReadResult,
} from "./workflowBridge";

type DeprecatedComfyUIWindow = Window & {
  app?: {
    graphToPrompt?: () => Promise<unknown> | unknown;
  };
};

export type WorkflowReadStatus =
  | "success"
  | "invalid_graph"
  | "unavailable";

export interface WorkflowReadAttempt {
  status: WorkflowReadStatus;
  result: WorkflowReadResult | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function looksLikeApiWorkflow(workflow: Record<string, unknown>): boolean {
  const entries = Object.entries(workflow);
  if (entries.length === 0) return false;

  return entries.every(([, nodeData]) => {
    if (!isRecord(nodeData)) return false;
    return (
      typeof nodeData.class_type === "string" &&
      isRecord(nodeData.inputs ?? null)
    );
  });
}

function isTransientInvalidGraphError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const name = error.name.trim();
  const message = error.message.trim();

  if (name === "InvalidLinkError") {
    return true;
  }

  return (
    message.includes("InvalidLinkError") ||
    message.includes("No link found in parent graph")
  );
}

/**
 * DEPRECATED: preserved only for future API-shaped UI experiments built around
 * `app.graphToPrompt()`.
 *
 * The live interface does NOT use this module for workflow synchronization or
 * display info. Current UI sync/display come from graph-based helpers in
 * `workflowBridge.ts`, which read `activeWorkflow.activeState` directly.
 */
export async function readWorkflowFromIframe(
  iframe: HTMLIFrameElement,
  inputNodeMap?: InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
): Promise<WorkflowReadResult | null> {
  const attempt = await readWorkflowFromIframeDetailed(
    iframe,
    inputNodeMap,
    objectInfo,
  );
  return attempt.result;
}

/**
 * DEPRECATED: iframe round-trip reader that combines a graph snapshot from the
 * workflow store with an API workflow from `app.graphToPrompt()`.
 *
 * This helper is intentionally not part of the active sync/display path. It
 * remains here so future API-shaped workflows can reuse the edge-case handling
 * without rebuilding it from scratch.
 */
export async function readWorkflowFromIframeDetailed(
  iframe: HTMLIFrameElement,
  inputNodeMap?: InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
): Promise<WorkflowReadAttempt> {
  try {
    const win = iframe.contentWindow as DeprecatedComfyUIWindow | null;
    const activeWorkflow = readActiveWorkflowFromIframe(iframe);
    const graphToPrompt = win?.app?.graphToPrompt;
    let apiWorkflow: Record<string, unknown> | null = null;
    let graphData = activeWorkflow?.graphData ?? null;

    if (typeof graphToPrompt === "function" && win) {
      const rawResult = await graphToPrompt.call(win.app);

      if (Array.isArray(rawResult)) {
        const rawGraphData = asRecord(rawResult[0]);
        apiWorkflow = asRecord(rawResult[1]);
        if (!graphData) {
          graphData = rawGraphData;
        }
      } else if (isRecord(rawResult)) {
        apiWorkflow =
          asRecord(rawResult.output) ??
          asRecord(rawResult.prompt) ??
          asRecord(rawResult.apiWorkflow) ??
          null;

        if (!graphData) {
          graphData = asRecord(rawResult.workflow) ?? asRecord(rawResult.graph);
        }
      }
    }

    if (!apiWorkflow && graphData && looksLikeApiWorkflow(graphData)) {
      apiWorkflow = graphData;
    }

    if (!apiWorkflow) {
      return {
        status: "unavailable",
        result: null,
      };
    }
    if (!graphData) {
      graphData = apiWorkflow;
    }

    const inputs = parseInputsFromApiWorkflow(
      apiWorkflow,
      inputNodeMap,
      objectInfo,
    );
    return {
      status: "success",
      result: {
        workflow: apiWorkflow,
        graphData,
        inputs,
        filename: activeWorkflow?.filename ?? null,
      },
    };
  } catch (err) {
    if (isTransientInvalidGraphError(err)) {
      console.info(
        "[deprecatedApiWorkflowBridge] readWorkflowFromIframe skipped invalid graph state:",
        err,
      );
      return {
        status: "invalid_graph",
        result: null,
      };
    }

    console.warn(
      "[deprecatedApiWorkflowBridge] readWorkflowFromIframe failed:",
      err,
    );
    return {
      status: "unavailable",
      result: null,
    };
  }
}
