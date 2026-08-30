import type { JsonValue } from "@vlo/extension-sdk";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type {
  GeneratedCreationInput,
  GeneratedCreationReplayState,
} from "../../../types/Asset";
import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import type { WorkflowMaskCroppingMode } from "../types";
import type { GenerationAspectRatioSelection } from "../utils/aspectRatioSelection";
import type { WorkflowRules } from "../services/workflowRules";
import { TEMP_WORKFLOW_ID } from "../store/constants";
import {
  buildGeneratedCreationInputs,
  buildGeneratedCreationReplayState,
} from "../store/metadata";

/**
 * The panel-owned half of the saved state. Text and widget values live in the
 * panel component rather than the store, so the panel publishes them here for
 * persistence to read — in exactly the shape a replay restores from.
 */
export interface GenerationPanelValuesSnapshot {
  textValues: Record<string, string>;
  frontendStateWidgetValues: Record<string, unknown>;
  derivedWidgetInputs: Record<string, string>;
  widgetModes: Record<string, "fixed" | "randomize">;
  bypassNodeIds: readonly string[];
  activateNodeIds: readonly string[];
}

export const EMPTY_GENERATION_PANEL_VALUES: GenerationPanelValuesSnapshot = {
  textValues: {},
  frontendStateWidgetValues: {},
  derivedWidgetInputs: {},
  widgetModes: {},
  bypassNodeIds: [],
  activateNodeIds: [],
};

/**
 * What the generation panel restores to when a project is reopened: the
 * workflow that was active and everything filled into it.
 *
 * Deliberately shaped like the replay half of generated-asset metadata —
 * restoring a saved project and regenerating an asset are the same operation
 * with a different source, and they share the store's restore path.
 */
export interface GenerationPanelSnapshot {
  version: 1;
  /** A saved ComfyUI workflow id; never the temporary in-editor tab. */
  workflowId: string;
  targetResolution?: number;
  /** A short edge off the workflow's ladder stays a custom value on reload. */
  targetResolutionIsCustom?: boolean;
  inputs: GeneratedCreationInput[];
  replayState?: GeneratedCreationReplayState;
}

export interface BuildGenerationPanelSnapshotOptions {
  workflowId: string | null;
  workflowRules: WorkflowRules | null;
  workflowInputs: WorkflowInput[];
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  targetResolution: number;
  targetResolutionIsCustom: boolean;
  exactAspectRatio: boolean;
  aspectRatioSelection: GenerationAspectRatioSelection;
  maskCropMode: WorkflowMaskCroppingMode;
  maskCropDilation: number;
  values: GenerationPanelValuesSnapshot;
}

/**
 * Builds the snapshot to persist, or `null` when there is nothing worth
 * restoring — no workflow selected, or a temporary in-editor tab whose graph
 * belongs to ComfyUI's own session rather than to this project.
 */
export function buildGenerationPanelSnapshot(
  options: BuildGenerationPanelSnapshotOptions,
): GenerationPanelSnapshot | null {
  const { workflowId } = options;
  if (!workflowId || workflowId === TEMP_WORKFLOW_ID) {
    return null;
  }

  const replayState = buildGeneratedCreationReplayState({
    workflowSourceId: workflowId,
    workflowRules: options.workflowRules,
    workflowInputs: options.workflowInputs,
    textValues: options.values.textValues,
    frontendStateWidgetValues: options.values.frontendStateWidgetValues,
    widgetModes: options.values.widgetModes,
    derivedWidgetInputs: options.values.derivedWidgetInputs,
    bypassNodeIds: options.values.bypassNodeIds,
    activateNodeIds: options.values.activateNodeIds,
    exactAspectRatio: options.exactAspectRatio,
    aspectRatioSelection: options.aspectRatioSelection,
    targetResolution: options.targetResolution,
    maskCropMode: options.maskCropMode,
    maskCropDilation: options.maskCropDilation,
  });

  return {
    version: 1,
    workflowId,
    targetResolution: options.targetResolution,
    ...(options.targetResolutionIsCustom
      ? { targetResolutionIsCustom: true }
      : {}),
    inputs: buildGeneratedCreationInputs(
      options.workflowInputs,
      options.mediaInputs,
    ),
    ...(replayState ? { replayState } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInput(value: unknown): GeneratedCreationInput | null {
  if (!isRecord(value) || typeof value.nodeId !== "string") {
    return null;
  }
  const inputId = typeof value.inputId === "string" ? value.inputId : undefined;
  const includeEmbeddedAudio =
    value.includeEmbeddedAudio === true ? { includeEmbeddedAudio: true } : {};

  if (value.kind === "draggedAsset" && typeof value.parentAssetId === "string") {
    return {
      nodeId: value.nodeId,
      ...(inputId ? { inputId } : {}),
      ...includeEmbeddedAudio,
      kind: "draggedAsset",
      parentAssetId: value.parentAssetId,
    };
  }

  if (value.kind === "timelineSelection" && isRecord(value.timelineSelection)) {
    return {
      nodeId: value.nodeId,
      ...(inputId ? { inputId } : {}),
      ...includeEmbeddedAudio,
      kind: "timelineSelection",
      timelineSelection: value.timelineSelection as unknown as TimelineSelection,
    };
  }

  return null;
}

/**
 * Reads a snapshot back off disk. Anything unrecognized is dropped rather than
 * rejected wholesale: a project written by a newer build should still reopen on
 * its workflow, just without whatever this build cannot interpret.
 */
export function parseGenerationPanelSnapshot(
  value: unknown,
): GenerationPanelSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.workflowId !== "string" || !value.workflowId) return null;
  if (value.workflowId === TEMP_WORKFLOW_ID) return null;

  const inputs = Array.isArray(value.inputs)
    ? value.inputs.flatMap((entry) => {
        const parsed = parseInput(entry);
        return parsed ? [parsed] : [];
      })
    : [];

  return {
    version: 1,
    workflowId: value.workflowId,
    ...(typeof value.targetResolution === "number" &&
    Number.isFinite(value.targetResolution)
      ? { targetResolution: value.targetResolution }
      : {}),
    ...(value.targetResolutionIsCustom === true
      ? { targetResolutionIsCustom: true }
      : {}),
    inputs,
    ...(isRecord(value.replayState)
      ? { replayState: value.replayState as unknown as GeneratedCreationReplayState }
      : {}),
  };
}

/** The document layer stores the snapshot as opaque JSON. */
export function toPersistedGenerationPanel(
  snapshot: GenerationPanelSnapshot | null,
): JsonValue | null {
  return snapshot === null ? null : (JSON.parse(
    JSON.stringify(snapshot),
  ) as JsonValue);
}
