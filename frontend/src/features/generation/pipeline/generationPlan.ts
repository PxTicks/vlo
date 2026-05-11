import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import type { PromptResponse } from "../services/comfyuiApi";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";
import {
  getAspectRatioStage,
  getMaskProcessingStage,
  workflowPipelineStageAffectsPreparedAssets,
} from "../services/workflowRules";
import {
  buildFrontendStateControlKey,
  buildFrontendStateDerivedWidgetKey,
  buildFrontendStateWidgetKey,
} from "../services/frontendRuleState";
import {
  buildGeneratedCreationMetadata,
  findPreparedMaskFallback,
} from "../store/metadata";
import { frontendPreprocess } from "../utils/pipeline";
import { buildWorkflowInputMetadataMap } from "../utils/inputMetadata";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
} from "../utils/workflowInputs";
import { throwIfAborted } from "./utils/abort";
import type {
  DerivedMaskMapping,
  GenerationPlan,
  GenerationRequest,
  PreparedGeneration,
  ProjectConfig,
  SlotValue,
  SubmittedGeneration,
} from "./types";

interface CreateGenerationPlanOptions {
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown> | null;
  workflowId: string | null;
  workflowRules: WorkflowRules | null;
  workflowInputs: WorkflowInput[];
  workflowName: string;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  slotValues: Record<string, SlotValue>;
  derivedMaskMappings: DerivedMaskMapping[];
  exactAspectRatio: boolean;
  targetResolution: number;
  maskCropMode: import("../types").WorkflowMaskCroppingMode;
  maskCropDilation: number;
  widgetInputs: Record<string, string>;
  frontendStateWidgetValues: Record<string, unknown>;
  widgetModes: Record<string, "fixed" | "randomize">;
  derivedWidgetInputs: Record<string, string>;
  bypassNodeIds?: string[];
  postprocessConfig: import("../types").WorkflowPostprocessingConfig;
  workflowWarnings: WorkflowRuleWarning[];
  projectConfig: ProjectConfig;
}

interface PrepareGenerationPlanOptions {
  clientId: string;
  signal?: AbortSignal;
  cacheEntry?: GenerationPreprocessCacheEntry | null;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface CachedGenerationPreprocessAssets {
  targetAspectRatio: string | undefined;
  imageInputs: Record<string, File>;
  audioInputs: Record<string, File>;
  videoInputs: Record<string, File>;
  pipelineInputs: Record<string, Record<string, unknown>>;
}

interface CachedGenerationBackendMedia {
  cachedMediaInputs: Record<string, Record<string, unknown>>;
  pipelineOutputs: Record<string, Record<string, unknown>>;
}

export interface GenerationPreprocessCacheEntry {
  key: string;
  assets: CachedGenerationPreprocessAssets;
  backendMedia: CachedGenerationBackendMedia | null;
}

interface BackendPreprocessResponseData {
  comfyui_prompt?: Record<string, unknown>;
  pipeline_outputs?: Record<string, Record<string, unknown>>;
}

const SAVE_IMAGE_WEBSOCKET_NODE_TYPES = new Set([
  "SaveImageWebsocket",
  "VLOSaveImageWebsocketBMP",
]);
const MEMORY_LOADER_NODE_TYPES = new Set([
  "VLOMemoryLoadImage",
  "VLOMemoryLoadVideo",
  "VLOMemoryLoadAudio",
]);
const MEMORY_LOADER_PLACEHOLDER_VALUES = new Set(["loading..."]);
const MEMORY_LOADER_DISABLE_PARAM = "disable_in_memory";

function normalizeForStableStringify(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }
  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const normalized: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (typeof item === "undefined" || typeof item === "function") {
      continue;
    }
    normalized[key] = normalizeForStableStringify(item);
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function describeFileForCache(file: File | undefined): JsonValue {
  if (!file) {
    return null;
  }
  return {
    lastModified: file.lastModified,
    name: file.name,
    size: file.size,
    type: file.type,
  };
}

function hasMediaSlotValues(slotValues: Record<string, SlotValue>): boolean {
  return Object.values(slotValues).some((value) => value.type !== "text");
}

function buildMediaSlotCacheDescriptor(
  slotValues: Record<string, SlotValue>,
): JsonValue {
  const entries = Object.entries(slotValues)
    .filter(([, value]) => value.type !== "text")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([inputId, value]) => {
      if (
        value.type === "image" ||
        value.type === "audio" ||
        value.type === "video"
      ) {
        return [
          inputId,
          {
            file: describeFileForCache(value.file),
            type: value.type,
          },
        ];
      }

      if (value.type !== "video_selection") {
        return [
          inputId,
          {
            type: value.type,
          },
        ];
      }

      return [
        inputId,
        {
          preparedMaskFile: describeFileForCache(value.preparedMaskFile),
          preparedVideoFile: describeFileForCache(value.preparedVideoFile),
          selection: normalizeForStableStringify(value.selection),
          type: value.type,
        },
      ];
    });

  return Object.fromEntries(entries) as JsonValue;
}

function buildWorkflowInputCacheDescriptor(
  workflowInputs: WorkflowInput[],
): JsonValue {
  return workflowInputs
    .filter((input) => input.inputType !== "text")
    .map((input) => ({
      classType: input.classType,
      dispatch: normalizeForStableStringify(input.dispatch ?? null),
      id: input.id ?? null,
      inputType: input.inputType,
      nodeId: input.nodeId,
      origin: input.origin,
      param: input.param,
    }))
    .sort((left, right) =>
      `${left.id ?? ""}:${left.nodeId}:${left.param}`.localeCompare(
        `${right.id ?? ""}:${right.nodeId}:${right.param}`,
      ),
    );
}

function buildDerivedMaskCacheDescriptor(
  mappings: readonly DerivedMaskMapping[],
): JsonValue {
  return mappings
    .map((mapping) => ({
      maskNodeId: mapping.maskNodeId,
      maskParam: mapping.maskParam,
      maskType: mapping.maskType,
      purpose: mapping.purpose ?? null,
      renderFps: mapping.renderFps ?? null,
      sourceSelection: mapping.sourceSelection ?? null,
      maskSelection: mapping.maskSelection ?? null,
      sourceVideoTreatment: mapping.sourceVideoTreatment ?? null,
      sourceInputId: mapping.sourceInputId ?? null,
      sourceNodeId: mapping.sourceNodeId,
    }))
    .sort((left, right) =>
      [
        left.sourceInputId ?? "",
        left.sourceNodeId,
        left.maskNodeId,
        left.maskParam,
        left.purpose ?? "",
      ]
        .join(":")
        .localeCompare(
          [
            right.sourceInputId ?? "",
            right.sourceNodeId,
            right.maskNodeId,
            right.maskParam,
            right.purpose ?? "",
          ].join(":"),
        ),
    );
}

function buildAssetPipelineStageCacheDescriptor(
  rules: WorkflowRules | null | undefined,
): JsonValue {
  return (rules?.pipeline ?? [])
    .filter((stage) => workflowPipelineStageAffectsPreparedAssets(stage.kind))
    .map((stage) => normalizeForStableStringify(stage));
}

function getPipelineStateReferenceKey(ref: unknown): string | null {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    return null;
  }

  const record = ref as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : null;
  if (kind === "frontend_control") {
    return typeof record.control_id === "string"
      ? buildFrontendStateControlKey(record.control_id)
      : null;
  }
  if (kind === "derived_widget") {
    return typeof record.derived_widget_id === "string"
      ? buildFrontendStateDerivedWidgetKey(record.derived_widget_id)
      : null;
  }
  if (
    (kind === "workflow_param" || kind === null) &&
    typeof record.node_id === "string" &&
    typeof record.param === "string"
  ) {
    return buildFrontendStateWidgetKey(record.node_id, record.param);
  }

  return null;
}

function collectPipelineConnectedFrontendStateKeys(
  rules: WorkflowRules | null | undefined,
): string[] {
  const keys = new Set<string>();

  for (const stage of rules?.pipeline ?? []) {
    if (
      !workflowPipelineStageAffectsPreparedAssets(stage.kind)
    ) {
      continue;
    }

    for (const control of stage.controls ?? []) {
      const bindKey = getPipelineStateReferenceKey(control.bind);
      if (bindKey) {
        keys.add(bindKey);
      }

      for (const defaultRule of control.default_rules ?? []) {
        const defaultRuleKey = getPipelineStateReferenceKey(
          defaultRule.when?.ref,
        );
        if (defaultRuleKey) {
          keys.add(defaultRuleKey);
        }
      }
    }
  }

  return [...keys].sort();
}

function buildPipelineConnectedFrontendStateCacheDescriptor(
  rules: WorkflowRules | null | undefined,
  frontendStateWidgetValues: Record<string, unknown>,
): JsonValue {
  const entries = collectPipelineConnectedFrontendStateKeys(rules).map((key) => [
    key,
    normalizeForStableStringify(frontendStateWidgetValues[key] ?? null),
  ]);
  return Object.fromEntries(entries) as JsonValue;
}

function hasRandomizedPipelineConnectedWidget(
  rules: WorkflowRules | null | undefined,
  widgetModes: Record<string, "fixed" | "randomize">,
): boolean {
  for (const key of collectPipelineConnectedFrontendStateKeys(rules)) {
    if (!key.startsWith("widget_")) {
      continue;
    }
    const widgetModeKey = `widget_mode_${key.slice("widget_".length)}`;
    if (widgetModes[widgetModeKey] === "randomize") {
      return true;
    }
  }
  return false;
}

function coerceBooleanLike(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off" ||
      normalized === ""
    ) {
      return false;
    }
  }
  return false;
}

function buildMemoryLoaderModeCacheDescriptor(
  workflow: Record<string, unknown> | null,
  widgetInputs: Record<string, string>,
): JsonValue {
  if (!workflow) {
    return {};
  }

  const entries = Object.entries(workflow)
    .filter(([, node]) => {
      if (typeof node !== "object" || node === null || Array.isArray(node)) {
        return false;
      }
      const classType = (node as { class_type?: unknown }).class_type;
      return (
        typeof classType === "string" &&
        MEMORY_LOADER_NODE_TYPES.has(classType)
      );
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, node]) => {
      const widgetKey = `widget_${nodeId}_${MEMORY_LOADER_DISABLE_PARAM}`;
      const widgetOverride = widgetInputs[widgetKey];
      const inputs =
        typeof node === "object" && node !== null && !Array.isArray(node)
          ? ((node as { inputs?: unknown }).inputs ?? null)
          : null;
      const rawValue =
        typeof widgetOverride !== "undefined"
          ? widgetOverride
          : typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
            ? (inputs as Record<string, unknown>)[MEMORY_LOADER_DISABLE_PARAM]
            : undefined;
      return [nodeId, coerceBooleanLike(rawValue)];
    });

  return Object.fromEntries(entries) as JsonValue;
}

function cloneFileRecord(record: Record<string, File>): Record<string, File> {
  return { ...record };
}

function cloneUnknownRecord(
  record: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return structuredClone(record);
}

function collectTextInputsForRequest(
  workflowInputs: WorkflowInput[],
  slotValues: Record<string, SlotValue>,
): Record<string, string> {
  const textInputs: Record<string, string> = {};
  const inputById = buildWorkflowInputLookup(workflowInputs);

  for (const [inputId, value] of Object.entries(slotValues)) {
    if (value.type !== "text") continue;
    const input = inputById.get(inputId);
    if (!input) continue;
    textInputs[getNodeInputRequestKey(input, inputById)] = value.value;
  }

  return textInputs;
}

export function getSaveImageWebsocketNodeIds(
  workflow: Record<string, unknown> | null,
): Set<string> {
  const ids = new Set<string>();
  if (!workflow) return ids;

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      continue;
    }
    const nodeClassType = (node as { class_type?: unknown }).class_type;
    if (
      typeof nodeClassType === "string" &&
      SAVE_IMAGE_WEBSOCKET_NODE_TYPES.has(nodeClassType)
    ) {
      ids.add(nodeId);
    }
  }

  return ids;
}

function isWindowLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (value === globalThis) {
    return true;
  }

  if (typeof Window !== "undefined" && value instanceof Window) {
    return true;
  }

  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Window]" || tag === "[object DOMWindow]") {
    return true;
  }

  const candidate = value as {
    window?: unknown;
    self?: unknown;
  };
  return candidate.window === value || candidate.self === value;
}

function isDomNodeLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (typeof Node !== "undefined" && value instanceof Node) {
    return true;
  }

  const candidate = value as {
    nodeType?: unknown;
    nodeName?: unknown;
  };
  return (
    typeof candidate.nodeType === "number" &&
    typeof candidate.nodeName === "string"
  );
}

function cloneSerializableRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return null;

  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === "function" || typeof candidate === "symbol") {
      return undefined;
    }
    if (isWindowLike(candidate) || isDomNodeLike(candidate)) {
      return undefined;
    }
    if (typeof candidate === "object" && candidate !== null) {
      if (seen.has(candidate)) {
        return undefined;
      }
      seen.add(candidate);
    }
    return candidate;
  });

  return serialized ? (JSON.parse(serialized) as Record<string, unknown>) : null;
}

function cloneSerializableValue<T>(value: T): T {
  return cloneSerializableRecord({ value })?.value as T;
}

function cloneSlotValues(
  slotValues: Record<string, SlotValue>,
): Record<string, SlotValue> {
  const next: Record<string, SlotValue> = {};

  for (const [key, value] of Object.entries(slotValues)) {
    switch (value.type) {
      case "text":
      case "image":
      case "audio":
      case "video":
        next[key] = { ...value };
        break;
      case "video_selection":
        next[key] = {
          ...value,
          selection: {
            ...value.selection,
            clips: value.selection.clips.slice(),
          },
        };
        break;
    }
  }

  return next;
}

export function buildGenerationPreprocessCacheKey(
  plan: GenerationPlan,
): string | null {
  if (!hasMediaSlotValues(plan.preprocess.slotValues)) {
    return null;
  }
  if (
    hasRandomizedPipelineConnectedWidget(
      plan.workflow.workflowRules,
      plan.submission.widgetModes,
    )
  ) {
    return null;
  }

  return stableStringify({
    derivedMaskMappings: buildDerivedMaskCacheDescriptor(
      plan.preprocess.derivedMaskMappings,
    ),
    exactAspectRatio: plan.preprocess.exactAspectRatio,
    maskCropDilation: plan.preprocess.maskCropDilation,
    maskCropMode: plan.preprocess.maskCropMode,
    mediaSlots: buildMediaSlotCacheDescriptor(plan.preprocess.slotValues),
    projectConfig: plan.preprocess.projectConfig,
    targetResolution: plan.preprocess.targetResolution,
    memoryLoaderModes: buildMemoryLoaderModeCacheDescriptor(
      plan.workflow.workflow,
      plan.submission.widgetInputs,
    ),
    workflowId: plan.workflow.workflowId,
    workflowInputs: buildWorkflowInputCacheDescriptor(
      plan.workflow.workflowInputs,
    ),
    workflowPipelineState: buildPipelineConnectedFrontendStateCacheDescriptor(
      plan.workflow.workflowRules,
      plan.submission.frontendStateWidgetValues,
    ),
    workflowPipeline: buildAssetPipelineStageCacheDescriptor(
      plan.workflow.workflowRules,
    ),
  });
}

function buildGenerationRequestFromCache(
  plan: GenerationPlan,
  clientId: string,
  cacheEntry: GenerationPreprocessCacheEntry,
): GenerationRequest {
  const backendMedia = cacheEntry.backendMedia;

  return {
    workflow: plan.workflow.workflow,
    graphData: plan.workflow.graphData,
    workflowId: plan.workflow.workflowId,
    exactAspectRatio: plan.preprocess.exactAspectRatio,
    targetAspectRatio: cacheEntry.assets.targetAspectRatio,
    targetResolution: plan.preprocess.targetResolution,
    textInputs: collectTextInputsForRequest(
      plan.workflow.workflowInputs,
      plan.preprocess.slotValues,
    ),
    imageInputs: backendMedia
      ? {}
      : cloneFileRecord(cacheEntry.assets.imageInputs),
    videoInputs: backendMedia
      ? {}
      : cloneFileRecord(cacheEntry.assets.videoInputs),
    audioInputs: backendMedia
      ? {}
      : cloneFileRecord(cacheEntry.assets.audioInputs),
    ...(backendMedia
      ? {
          cachedMediaInputs: cloneUnknownRecord(backendMedia.cachedMediaInputs),
        }
      : {}),
    maskCropMode: plan.preprocess.maskCropMode,
    maskCropDilation:
      plan.preprocess.maskCropMode === "full"
        ? undefined
        : plan.preprocess.maskCropDilation,
    pipelineInputs: cloneUnknownRecord(cacheEntry.assets.pipelineInputs),
    clientId,
  };
}

export function buildGenerationPreprocessCacheEntry(
  key: string,
  prepared: PreparedGeneration,
): GenerationPreprocessCacheEntry {
  return {
    key,
    assets: {
      targetAspectRatio: prepared.request.targetAspectRatio,
      imageInputs: cloneFileRecord(prepared.request.imageInputs),
      audioInputs: cloneFileRecord(prepared.request.audioInputs),
      videoInputs: cloneFileRecord(prepared.request.videoInputs),
      pipelineInputs: cloneUnknownRecord(prepared.request.pipelineInputs ?? {}),
    },
    backendMedia: null,
  };
}

function addMediaReference(
  references: Map<string, Set<string>>,
  nodeId: string,
  param: string,
): void {
  const params = references.get(nodeId) ?? new Set<string>();
  params.add(param);
  references.set(nodeId, params);
}

function collectCacheableMediaReferences(
  plan: GenerationPlan,
): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  const inputById = buildWorkflowInputLookup(plan.workflow.workflowInputs);
  const sourceKeysWithDerivedMasks = new Set<string>();

  for (const [inputId, value] of Object.entries(plan.preprocess.slotValues)) {
    if (value.type === "text") {
      continue;
    }

    const input = inputById.get(inputId);
    if (!input) {
      continue;
    }

    addMediaReference(references, input.nodeId, input.param);
    if (value.type === "video_selection") {
      sourceKeysWithDerivedMasks.add(inputId);
      sourceKeysWithDerivedMasks.add(input.nodeId);
    }
  }

  for (const mapping of plan.preprocess.derivedMaskMappings) {
    if (
      sourceKeysWithDerivedMasks.has(mapping.sourceInputId ?? "") ||
      sourceKeysWithDerivedMasks.has(mapping.sourceNodeId)
    ) {
      addMediaReference(references, mapping.maskNodeId, mapping.maskParam);
    }
  }

  return references;
}

function getWorkflowNodeInputValue(
  workflow: Record<string, unknown>,
  nodeId: string,
  param: string,
): unknown {
  const node = workflow[nodeId];
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return undefined;
  }
  const inputs = (node as { inputs?: unknown }).inputs;
  if (
    typeof inputs !== "object" ||
    inputs === null ||
    Array.isArray(inputs)
  ) {
    return undefined;
  }
  return (inputs as Record<string, unknown>)[param];
}

function isMemoryLoaderPlaceholderValue(
  workflow: Record<string, unknown>,
  nodeId: string,
  value: unknown,
): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const node = workflow[nodeId];
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return false;
  }

  const classType = (node as { class_type?: unknown }).class_type;
  if (
    typeof classType !== "string" ||
    !MEMORY_LOADER_NODE_TYPES.has(classType)
  ) {
    return false;
  }

  return MEMORY_LOADER_PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

function isCacheableMediaInputValue(
  workflow: Record<string, unknown>,
  nodeId: string,
  value: unknown,
): boolean {
  if (value === null || typeof value === "undefined") {
    return false;
  }
  if (typeof value === "string") {
    return (
      value.trim().length > 0 &&
      !isMemoryLoaderPlaceholderValue(workflow, nodeId, value)
    );
  }
  return true;
}

function extractCachedMediaInputs(
  plan: GenerationPlan,
  workflow: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> | null {
  if (!workflow) {
    return null;
  }

  const references = collectCacheableMediaReferences(plan);
  if (references.size === 0) {
    return null;
  }

  const cachedMediaInputs: Record<string, Record<string, unknown>> = {};
  for (const [nodeId, params] of references.entries()) {
    for (const param of params) {
      const value = getWorkflowNodeInputValue(workflow, nodeId, param);
      if (!isCacheableMediaInputValue(workflow, nodeId, value)) {
        return null;
      }
      cachedMediaInputs[nodeId] = {
        ...cachedMediaInputs[nodeId],
        [param]: value,
      };
    }
  }

  return cachedMediaInputs;
}

export function updateGenerationPreprocessCacheFromResponse(
  entry: GenerationPreprocessCacheEntry,
  plan: GenerationPlan,
  response: BackendPreprocessResponseData,
): GenerationPreprocessCacheEntry {
  const cachedMediaInputs = extractCachedMediaInputs(
    plan,
    response.comfyui_prompt,
  );
  if (!cachedMediaInputs) {
    return entry;
  }

  return {
    ...entry,
    backendMedia: {
      cachedMediaInputs,
      pipelineOutputs: cloneUnknownRecord(response.pipeline_outputs ?? {}),
    },
  };
}

export function mergeCachedPipelineOutputsIntoResponse<
  TResponse extends BackendPreprocessResponseData,
>(
  response: TResponse,
  cacheEntry: GenerationPreprocessCacheEntry | null,
): TResponse {
  const cachedPipelineOutputs = cacheEntry?.backendMedia?.pipelineOutputs;
  if (!cachedPipelineOutputs || Object.keys(cachedPipelineOutputs).length === 0) {
    return response;
  }

  const cachedStages = cloneUnknownRecord(cachedPipelineOutputs);
  const responseStages = (response.pipeline_outputs ?? {}) as Record<
    string,
    unknown
  >;
  const merged: Record<string, unknown> = { ...cachedStages };

  for (const [stageId, value] of Object.entries(responseStages)) {
    // Cached preprocess paths leave inactive stages emitting an empty `{}`
    // (the backend pipeline runner pre-allocates a slot per stage). Keep the
    // cached value in that case so e.g. mask_crop_metadata survives reruns.
    const isEmptyObject =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0;
    if (isEmptyObject && stageId in cachedStages) {
      continue;
    }
    merged[stageId] = value;
  }

  return {
    ...response,
    pipeline_outputs: merged,
  };
}

function decodeProcessedMaskVideo(processedMaskVideo: string): File {
  const binaryStr = atob(processedMaskVideo);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i += 1) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  return new File([bytes], `generation-mask-${crypto.randomUUID()}.mp4`, {
    type: "video/mp4",
  });
}

export function createGenerationPlan(
  options: CreateGenerationPlanOptions,
): GenerationPlan {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    workflow: {
      workflow: cloneSerializableRecord(options.workflow),
      graphData: cloneSerializableRecord(options.graphData),
      workflowId: options.workflowId,
      workflowRules: cloneSerializableValue(options.workflowRules),
      workflowInputs: cloneSerializableValue(options.workflowInputs),
      submittedWorkflow: null,
      promptIsPreResolved: false,
    },
    preprocess: {
      slotValues: cloneSlotValues(options.slotValues),
      derivedMaskMappings: cloneSerializableValue(options.derivedMaskMappings),
      projectConfig: {
        fps: options.projectConfig.fps,
        aspectRatio: options.projectConfig.aspectRatio,
      },
      exactAspectRatio: options.exactAspectRatio,
      targetResolution: options.targetResolution,
      maskCropDilation: options.maskCropDilation,
      maskCropMode: options.maskCropMode,
    },
    submission: {
      widgetInputs: { ...options.widgetInputs },
      frontendStateWidgetValues: cloneSerializableValue(
        options.frontendStateWidgetValues,
      ),
      inputMetadata: cloneSerializableValue(
        buildWorkflowInputMetadataMap(
          options.workflowInputs,
          options.mediaInputs,
          options.projectConfig,
        ),
      ),
      widgetModes: { ...options.widgetModes },
      derivedWidgetInputs: { ...options.derivedWidgetInputs },
      bypassNodeIds: [...(options.bypassNodeIds ?? [])],
    },
    metadata: {
      generationMetadata: cloneSerializableValue(
        buildGeneratedCreationMetadata(
          {
            workflowName: options.workflowName,
            workflowSourceId: options.workflowId,
            workflowRules: options.workflowRules,
            workflowInputs: options.workflowInputs,
            mediaInputs: options.mediaInputs,
            slotValues: options.slotValues,
            targetResolution: options.targetResolution,
            exactAspectRatio: options.exactAspectRatio,
            maskCropMode: options.maskCropMode,
            maskCropDilation: options.maskCropDilation,
            frontendStateWidgetValues: options.frontendStateWidgetValues,
            widgetModes: options.widgetModes,
            derivedWidgetInputs: options.derivedWidgetInputs,
          },
        ),
      ),
      workflowWarnings: cloneSerializableValue(options.workflowWarnings),
    },
    postprocess: {
      config: {
        mode: options.postprocessConfig.mode,
        panel_preview: options.postprocessConfig.panel_preview,
        on_failure: options.postprocessConfig.on_failure,
        ...(options.postprocessConfig.stitch_fps != null
          ? { stitch_fps: options.postprocessConfig.stitch_fps }
          : {}),
      },
    },
  };
}

export async function prepareGenerationPlan(
  plan: GenerationPlan,
  options: PrepareGenerationPlanOptions,
): Promise<PreparedGeneration> {
  const cacheKey = buildGenerationPreprocessCacheKey(plan);
  const request =
    cacheKey !== null && options.cacheEntry?.key === cacheKey
      ? buildGenerationRequestFromCache(
          plan,
          options.clientId,
          options.cacheEntry,
        )
      : await frontendPreprocess(
          plan.workflow.workflow,
          plan.workflow.workflowId,
          plan.workflow.workflowRules,
          plan.workflow.workflowInputs,
          plan.preprocess.slotValues,
          options.clientId,
          plan.preprocess.derivedMaskMappings,
          plan.preprocess.maskCropDilation,
          {
            exactAspectRatio: plan.preprocess.exactAspectRatio,
            maskCropMode: plan.preprocess.maskCropMode,
            projectConfig: plan.preprocess.projectConfig,
            signal: options.signal,
            targetResolution: plan.preprocess.targetResolution,
          },
          plan.workflow.graphData,
        );
  throwIfAborted(options.signal);

  // Snapshot the widget mode, not a realized random value. The backend
  // resolves "randomize" controls per /generate request, so queued batches
  // still get fresh seeds and other randomized widget values.
  if (Object.keys(plan.submission.widgetInputs).length > 0) {
    request.widgetInputs = { ...plan.submission.widgetInputs };
  }
  if (Object.keys(plan.submission.widgetModes).length > 0) {
    request.widgetModes = { ...plan.submission.widgetModes };
  }
  if (Object.keys(plan.submission.derivedWidgetInputs).length > 0) {
    request.derivedWidgetInputs = { ...plan.submission.derivedWidgetInputs };
  }
  if (Object.keys(plan.submission.inputMetadata).length > 0) {
    request.inputMetadata = cloneSerializableValue(plan.submission.inputMetadata);
  }

  return {
    plan,
    request,
  };
}

export function buildSubmittedGeneration(
  prepared: PreparedGeneration,
  response: PromptResponse,
  options: {
    autoFamilyRequestKey?: string | null;
  } = {},
): SubmittedGeneration {
  const responseWarnings = Array.isArray(response.workflow_warnings)
    ? response.workflow_warnings
    : [];
  const appliedWidgetValues = response.applied_widget_values ?? {};
  const pipelineOutputs = response.pipeline_outputs ?? {};
  const aspectRatioStage = getAspectRatioStage(
    prepared.plan.workflow.workflowRules,
  );
  const aspectRatioProcessing =
    aspectRatioStage &&
    typeof pipelineOutputs[aspectRatioStage.id] === "object" &&
    pipelineOutputs[aspectRatioStage.id] !== null
      ? ((pipelineOutputs[aspectRatioStage.id]?.aspect_ratio_processing ??
          null) as SubmittedGeneration["aspectRatioProcessing"])
      : null;
  const generationMetadata = structuredClone(
    prepared.plan.metadata.generationMetadata,
  );

  const maskProcessingStage = getMaskProcessingStage(
    prepared.plan.workflow.workflowRules,
  );
  const maskPipelineOutput =
    maskProcessingStage &&
    typeof pipelineOutputs[maskProcessingStage.id] === "object" &&
    pipelineOutputs[maskProcessingStage.id] !== null
      ? pipelineOutputs[maskProcessingStage.id]
      : null;

  if (maskPipelineOutput?.mask_crop_metadata) {
    generationMetadata.maskCropMetadata =
      maskPipelineOutput.mask_crop_metadata as typeof generationMetadata.maskCropMetadata;
  }
  if (response.comfyui_prompt) {
    generationMetadata.comfyuiPrompt = response.comfyui_prompt;
  }
  if (prepared.plan.workflow.graphData) {
    generationMetadata.comfyuiWorkflow = prepared.plan.workflow.graphData;
  } else if (response.comfyui_workflow) {
    generationMetadata.comfyuiWorkflow = response.comfyui_workflow;
  }

  let preparedMaskFile = findPreparedMaskFallback(
    prepared.plan.preprocess.slotValues,
    prepared.plan.preprocess.derivedMaskMappings,
    prepared.plan.workflow.workflowInputs,
  );
  if (typeof maskPipelineOutput?.processed_mask_video === "string") {
    preparedMaskFile = decodeProcessedMaskVideo(
      maskPipelineOutput.processed_mask_video,
    );
  }

  const saveImageWebsocketNodeIds = getSaveImageWebsocketNodeIds(
    prepared.request.workflow,
  );

  return {
    prepared,
    promptId: response.prompt_id,
    deliveryId: response.delivery_id ?? null,
    responseWarnings,
    appliedWidgetValues,
    aspectRatioProcessing,
    generationMetadata,
    preparedMaskFile,
    autoFamilyRequestKey: options.autoFamilyRequestKey ?? null,
    usesSaveImageWebsocketOutputs: saveImageWebsocketNodeIds.size > 0,
    saveImageWebsocketNodeIds,
  };
}
