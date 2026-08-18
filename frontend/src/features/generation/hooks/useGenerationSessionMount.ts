import { useCallback, useEffect, useMemo, useRef } from "react";
import { generationSessionService } from "../services/GenerationSessionService";
import {
  buildGenerationNodeCatalogue,
  computeGenerationCatalogueFingerprint,
} from "../services/workflowNodeCatalogue";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationInputSnapshot,
  GenerationNodeSnapshot,
  GenerationSessionCommit,
  GenerationSessionJsonValue,
  GenerationTransactionResult,
  GenerationWorkflowSourceMode,
} from "../services/generationSessionTypes";
import { TEMP_WORKFLOW_ID, useGenerationStore } from "../useGenerationStore";
import type { WorkflowInput, WorkflowWidgetInput } from "../types";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "../utils/workflowInputs";
import type { WidgetValueMap } from "../utils/widgetValueReconciliation";

/**
 * Mounts the generation session for the panel and routes the panel's own
 * writes through it (docs/generation-native-extension-seams-plan.md §N2).
 *
 * The panel is the session's owner: it publishes the reactive snapshot and
 * supplies the commit side. Native controls call the returned helpers, which
 * run the same `transaction` a trusted extension adapter runs, so both share
 * validation, atomicity, and failure codes.
 */

export interface GenerationSessionMountOptions {
  /** Shared catalogue used by native autodiscovery and session publication. */
  readonly nodes?: readonly GenerationNodeSnapshot[];
  /** Panel input slots, in display order. */
  readonly workflowInputs: readonly WorkflowInput[];
  readonly textValues: Record<string, string>;
  /** Every widget the panel renders a control for, pipeline widgets included. */
  readonly widgetInputs: readonly WorkflowWidgetInput[];
  readonly widgetValues: WidgetValueMap;
  readonly selectedWorkflowId: string | null;
  /** The workflow failed to load; readiness will not arrive on its own. */
  readonly hasWorkflowError: boolean;
  /** The panel's own submit gate, connection and input validation included. */
  readonly canSubmit: boolean;
  readonly commitTextInputs: (updates: ReadonlyMap<string, string>) => void;
  readonly applyWidgetValue: (
    nodeId: string,
    param: string,
    value: unknown,
  ) => void;
}

export interface GenerationSessionMountResult {
  readonly commitTextValue: (
    inputId: string,
    value: string,
  ) => GenerationTransactionResult;
  readonly commitTextValues: (
    updates: ReadonlyMap<string, string>,
  ) => GenerationTransactionResult;
  readonly commitWidgetValue: (
    nodeId: string,
    param: string,
    value: unknown,
  ) => GenerationTransactionResult;
}

function toJsonValue(value: unknown): GenerationSessionJsonValue | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function resolveWorkflowSourceMode(
  selectedWorkflowId: string | null,
): GenerationWorkflowSourceMode {
  if (selectedWorkflowId === TEMP_WORKFLOW_ID) return "temporary";
  return selectedWorkflowId === null ? "manual" : "catalogue";
}

function reportTransaction(
  result: GenerationTransactionResult,
  context: string,
): GenerationTransactionResult {
  if (!result.ok) {
    console.warn(
      `[generation] ${context} rejected (${result.code}): ${result.message}`,
    );
  }
  return result;
}

export function useGenerationSessionMount(
  options: GenerationSessionMountOptions,
): GenerationSessionMountResult {
  const {
    workflowInputs,
    nodes: providedNodes,
    textValues,
    widgetInputs,
    widgetValues,
    selectedWorkflowId,
    hasWorkflowError,
    canSubmit,
    commitTextInputs,
    applyWidgetValue,
  } = options;

  const syncedWorkflow = useGenerationStore((s) => s.syncedWorkflow);
  const syncedGraphData = useGenerationStore((s) => s.syncedGraphData);
  const rawObjectInfo = useGenerationStore((s) => s.rawObjectInfo);
  const instanceId = useGenerationStore((s) => s.iframeWorkflowInstanceId);
  const isWorkflowLoading = useGenerationStore((s) => s.isWorkflowLoading);
  const isWorkflowReady = useGenerationStore((s) => s.isWorkflowReady);
  const queuedCount = useGenerationStore((s) => s.generationQueue.length);
  const activeJobId = useGenerationStore((s) => s.activeJobId);
  const jobs = useGenerationStore((s) => s.jobs);
  const pipelinePhase = useGenerationStore((s) => s.pipelineStatus.phase);

  // A failed submission leaves an errored job installed as the active one, so
  // job *status* is what says whether work is still in flight — the same rule
  // the panel's own busy state uses.
  const activeJobStatus = activeJobId
    ? (jobs.get(activeJobId)?.status ?? null)
    : null;
  const isBusy =
    activeJobStatus === "queued" ||
    activeJobStatus === "running" ||
    pipelinePhase !== "idle" ||
    queuedCount > 0;

  const nodes = useMemo(
    () =>
      providedNodes ??
      buildGenerationNodeCatalogue(
        syncedWorkflow,
        rawObjectInfo,
        syncedGraphData,
      ),
    [providedNodes, rawObjectInfo, syncedGraphData, syncedWorkflow],
  );
  const fingerprint = useMemo(
    () => computeGenerationCatalogueFingerprint(nodes),
    [nodes],
  );

  const inputLookup = useMemo(
    () => buildWorkflowInputLookup(workflowInputs),
    [workflowInputs],
  );
  const inputs = useMemo<readonly GenerationInputSnapshot[]>(
    () =>
      workflowInputs.map((input) => {
        const id = getWorkflowInputId(input);
        const textValue =
          input.inputType === "text"
            ? (getWorkflowInputValue(textValues, input, inputLookup) ??
              (typeof input.currentValue === "string"
                ? input.currentValue
                : ""))
            : undefined;
        return Object.freeze({
          id,
          nodeId: input.nodeId,
          param: input.param,
          label: input.label,
          ...(input.description ? { description: input.description } : {}),
          inputType: input.inputType,
          ...(textValue !== undefined ? { value: textValue } : {}),
        }) as GenerationInputSnapshot;
      }),
    [inputLookup, textValues, workflowInputs],
  );

  const editableWidgets = useMemo<
    readonly GenerationEditableWidgetSnapshot[]
  >(
    () =>
      widgetInputs.map((widget) => {
        const value =
          widgetValues[widget.nodeId]?.[widget.param] ?? widget.currentValue;
        return Object.freeze({
          target: Object.freeze({
            nodeId: widget.nodeId,
            widget: widget.param,
          }),
          valueType: widget.config.valueType ?? "unknown",
          value: toJsonValue(value),
          // Copied and frozen: the snapshot must not hand out a live reference
          // into the panel's widget configuration.
          options: widget.config.options
            ? Object.freeze([...widget.config.options])
            : null,
          min: widget.config.min ?? null,
          max: widget.config.max ?? null,
          trueValue: toJsonValue(widget.config.trueValue),
          falseValue: toJsonValue(widget.config.falseValue),
        }) as GenerationEditableWidgetSnapshot;
      }),
    [widgetInputs, widgetValues],
  );

  // The host stays identity-stable so the session mounts once per panel and
  // publishes into the same session across re-renders.
  const commitRef = useRef<(update: GenerationSessionCommit) => void>(() => {});
  useEffect(() => {
    commitRef.current = (update: GenerationSessionCommit) => {
      if (update.textInputs.size > 0) commitTextInputs(update.textInputs);
      for (const widget of update.widgets) {
        applyWidgetValue(
          widget.target.nodeId,
          widget.target.widget,
          widget.value,
        );
      }
    };
  }, [applyWidgetValue, commitTextInputs]);
  const host = useMemo(
    () => ({ commit: (update: GenerationSessionCommit) => commitRef.current(update) }),
    [],
  );

  useEffect(() => generationSessionService.mount(host), [host]);

  useEffect(() => {
    generationSessionService.publish({
      sourceId: selectedWorkflowId,
      instanceId,
      fingerprint,
      mode: resolveWorkflowSourceMode(selectedWorkflowId),
      nodes,
      inputs,
      editableWidgets,
      readiness: {
        isLoading: isWorkflowLoading,
        isReady: isWorkflowReady,
        hasError: hasWorkflowError,
      },
      submission: { isBusy, queuedCount, canSubmit },
    });
  }, [
    canSubmit,
    editableWidgets,
    fingerprint,
    hasWorkflowError,
    inputs,
    instanceId,
    isBusy,
    isWorkflowLoading,
    isWorkflowReady,
    nodes,
    queuedCount,
    selectedWorkflowId,
  ]);

  const commitTextValues = useCallback(
    (updates: ReadonlyMap<string, string>) =>
      reportTransaction(
        generationSessionService.transaction("Panel text input", (transaction) => {
          for (const [inputId, value] of updates) {
            transaction.setTextInput(inputId, value);
          }
        }),
        "text input write",
      ),
    [],
  );

  const commitTextValue = useCallback(
    (inputId: string, value: string) =>
      commitTextValues(new Map([[inputId, value]])),
    [commitTextValues],
  );

  const commitWidgetValue = useCallback(
    (nodeId: string, param: string, value: unknown) =>
      reportTransaction(
        generationSessionService.transaction("Panel widget", (transaction) => {
          transaction.setWidget({ nodeId, widget: param }, value);
        }),
        `widget write ${nodeId}.${param}`,
      ),
    [],
  );

  return { commitTextValue, commitTextValues, commitWidgetValue };
}
