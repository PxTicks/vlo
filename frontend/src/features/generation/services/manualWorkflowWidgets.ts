import type { WidgetValueType, WorkflowWidgetInput } from "../types";
import { isRecord } from "./parsers";
import {
  resolveClassInfo,
  resolveNodeDisplayTitle,
} from "./nodeTitles";

function isPrimitiveOption(
  value: unknown,
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isLinkValue(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2;
}

const CONTROL_MODE_VALUES = new Set([
  "fixed",
  "randomize",
  "increment",
  "decrement",
]);

// `control_after_generate` in object_info appears as either `true` (e.g. KSampler's
// seed) or a string mode like `"fixed"` (e.g. PrimitiveInt's value). Either form
// means the widget occupies two slots in widgets_values: [value, mode]. Strict
// `=== true` checks miss the string form, causing PrimitiveInt-style widgets to
// be misaligned and their randomize state to go undetected.
function hasControlAfterGenerate(opts: Record<string, unknown>): boolean {
  const value = opts.control_after_generate;
  if (value === true) return true;
  if (typeof value === "string" && CONTROL_MODE_VALUES.has(value)) return true;
  return false;
}

// Fallback widget layouts used when object_info hasn't loaded or doesn't contain
// the class — e.g. on cold start before ComfyUI publishes object_info, or for
// stock seed-providing nodes that aren't yet registered. Ordering matches the
// slot order ComfyUI uses in widgets_values.
const SEED_FALLBACK_WIDGETS: Record<
  string,
  ReadonlyArray<{ name: string; controlAfterGenerate?: boolean }>
> = {
  RandomNoise: [{ name: "noise_seed", controlAfterGenerate: true }],
  KSampler: [
    { name: "seed", controlAfterGenerate: true },
    { name: "steps" },
    { name: "cfg" },
    { name: "sampler_name" },
    { name: "scheduler" },
    { name: "denoise" },
  ],
  KSamplerAdvanced: [
    { name: "add_noise" },
    { name: "noise_seed", controlAfterGenerate: true },
    { name: "steps" },
    { name: "cfg" },
    { name: "sampler_name" },
    { name: "scheduler" },
    { name: "start_at_step" },
    { name: "end_at_step" },
    { name: "return_with_leftover_noise" },
  ],
  PrimitiveInt: [{ name: "value", controlAfterGenerate: true }],
  PrimitiveNode: [{ name: "value", controlAfterGenerate: true }],
};

interface FallbackWidgetSlot {
  name: string;
  slot: number;
  controlAfterGenerate: boolean;
}

function buildFallbackWidgetSlots(
  classType: string | undefined,
): FallbackWidgetSlot[] {
  if (!classType) return [];
  const layout = SEED_FALLBACK_WIDGETS[classType];
  if (!layout) return [];
  const slots: FallbackWidgetSlot[] = [];
  let slot = 0;
  for (const param of layout) {
    const cag = param.controlAfterGenerate === true;
    slots.push({ name: param.name, slot, controlAfterGenerate: cag });
    slot += cag ? 2 : 1;
  }
  return slots;
}

function resolveGraphNode(
  graphData: Record<string, unknown> | null,
  nodeId: string,
): Record<string, unknown> | null {
  const nodes = graphData?.nodes;
  if (!Array.isArray(nodes)) return null;

  const node = nodes.find((candidate) => {
    if (!isRecord(candidate)) return false;
    return String(candidate.id) === nodeId;
  });
  return isRecord(node) ? node : null;
}

function resolveGraphNodes(
  graphData: Record<string, unknown> | null,
): Record<string, unknown>[] {
  const nodes = graphData?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(isRecord);
}

function resolveNodeTitle(
  nodeId: string,
  node: Record<string, unknown>,
  graphData: Record<string, unknown> | null,
  objectInfo: Record<string, unknown> | null,
): string {
  const meta = isRecord(node._meta) ? node._meta : null;
  const graphNode = resolveGraphNode(graphData, nodeId);
  const classType =
    typeof node.class_type === "string"
      ? node.class_type
      : typeof graphNode?.type === "string"
        ? graphNode.type
        : undefined;

  return (
    resolveNodeDisplayTitle({
      workflowTitle: meta?.title,
      graphTitle: graphNode?.title,
      classType,
      objectInfo,
    }) ??
    `Node ${nodeId}`
  );
}

function inferWidgetValueType(value: unknown): WidgetValueType {
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "string") {
    return "string";
  }
  return "unknown";
}

function coerceWidgetOptions(
  typeSpec: unknown,
  opts: Record<string, unknown>,
): Array<string | number | boolean> | undefined {
  if (Array.isArray(typeSpec) && typeSpec.every(isPrimitiveOption)) {
    return typeSpec;
  }

  if (
    typeof typeSpec === "string" &&
    typeSpec.trim().toUpperCase() === "COMBO" &&
    Array.isArray(opts.options)
  ) {
    const options = opts.options.filter(isPrimitiveOption);
    return options.length > 0 ? options : undefined;
  }

  return undefined;
}

function getWidgetValueTypeFromTypeSpec(
  typeSpec: unknown,
  opts: Record<string, unknown>,
): WidgetValueType | null {
  if (typeof typeSpec === "string") {
    const normalized = typeSpec.trim().toUpperCase();
    if (normalized === "INT") return "int";
    if (normalized === "FLOAT") return "float";
    if (normalized === "STRING") return "string";
    if (normalized === "BOOLEAN") return "boolean";
    if (normalized === "COMBO" && coerceWidgetOptions(typeSpec, opts)) {
      return "enum";
    }
    if (normalized === typeSpec && normalized.length > 0) {
      return null;
    }
    return "unknown";
  }

  if (Array.isArray(typeSpec)) {
    return coerceWidgetOptions(typeSpec, opts) ? "enum" : "unknown";
  }

  return "unknown";
}

function isManualWidgetParam(param: string, nodeTitle: string): boolean {
  const normalizedParam = param.trim().toLowerCase();
  if (!normalizedParam) return false;
  if (isSeedWidgetParam(param)) {
    return true;
  }
  if (normalizedParam.includes("seed") || normalizedParam.includes("random")) {
    return true;
  }

  if (normalizedParam !== "value") {
    return false;
  }

  const normalizedTitle = nodeTitle.trim().toLowerCase();
  return (
    normalizedTitle.includes("seed") || normalizedTitle.includes("random")
  );
}

function isSeedWidgetParam(param: string): boolean {
  const normalizedParam = param.trim().toLowerCase();
  return normalizedParam === "seed" || normalizedParam === "noise_seed";
}

function resolveInputSpec(
  classInfo: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const input = classInfo?.input;
  return isRecord(input) ? input : null;
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
    const opts = isRecord(definition[1]) ? definition[1] : {};
    return [definition[0], opts];
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
    if (getWidgetValueTypeFromTypeSpec(typeSpec, opts) === null) {
      continue;
    }

    result.set(param, index);
    index += hasControlAfterGenerate(opts) ? 2 : 1;
  }

  return result;
}

function resolveGraphWidgetValue(
  graphData: Record<string, unknown> | null,
  nodeId: string,
  param: string,
  classInfo: Record<string, unknown> | null,
): unknown {
  const graphNode = resolveGraphNode(graphData, nodeId);
  if (!graphNode) return undefined;

  const widgetsValues = graphNode.widgets_values;
  if (!Array.isArray(widgetsValues)) return undefined;

  const widgetIndex = getWidgetValueIndexMap(classInfo).get(param);
  if (typeof widgetIndex !== "number") return undefined;
  return widgetsValues[widgetIndex];
}

function resolveGraphWidgetMode(
  graphData: Record<string, unknown> | null,
  nodeId: string,
  param: string,
  classInfo: Record<string, unknown> | null,
  opts: Record<string, unknown>,
): "fixed" | "randomize" | "increment" | "decrement" | null {
  if (!hasControlAfterGenerate(opts)) return null;

  const graphNode = resolveGraphNode(graphData, nodeId);
  if (!graphNode) return null;

  const widgetsValues = graphNode.widgets_values;
  if (!Array.isArray(widgetsValues)) return null;

  const widgetIndex = getWidgetValueIndexMap(classInfo).get(param);
  if (typeof widgetIndex !== "number") return null;

  const mode = widgetsValues[widgetIndex + 1];
  return mode === "fixed" ||
    mode === "randomize" ||
    mode === "increment" ||
    mode === "decrement"
    ? mode
    : null;
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function shouldIncludeObjectInfoWidget(
  param: string,
  nodeTitle: string,
  classType: string | undefined,
  definition: [unknown, Record<string, unknown>] | null,
  graphMode: ReturnType<typeof resolveGraphWidgetMode>,
): boolean {
  if (!definition) {
    return isManualWidgetParam(param, nodeTitle);
  }

  const [typeSpec, opts] = definition;
  const valueType = getWidgetValueTypeFromTypeSpec(typeSpec, opts);
  if (valueType === null) {
    return false;
  }

  if (
    param.trim().toLowerCase() === "cfg" &&
    (classType === "KSampler" || classType === "KSamplerAdvanced")
  ) {
    return true;
  }

  if (valueType === "int") {
    return isManualWidgetParam(param, nodeTitle) || graphMode === "randomize";
  }

  return hasControlAfterGenerate(opts) || isManualWidgetParam(param, nodeTitle);
}

export function resolveManualWidgetInputs(
  workflow: Record<string, unknown> | null,
  objectInfo: Record<string, unknown> | null,
  graphData: Record<string, unknown> | null = null,
): WorkflowWidgetInput[] {
  if (!workflow && !graphData) {
    return [];
  }

  const widgets: WorkflowWidgetInput[] = [];
  const graphOnlyNodes = !workflow
    ? resolveGraphNodes(graphData).flatMap((node) => {
        if (node.id == null) return [];
        if (node.mode === 2 || node.mode === 4) return [];
        const nodeId = String(node.id);
        const classType = typeof node.type === "string" ? node.type : undefined;
        return [[
          nodeId,
          {
            class_type: classType,
            inputs: {},
            _meta:
              typeof node.title === "string"
                ? {
                    title: node.title,
                  }
                : {},
          },
        ] as const];
      })
    : [];
  const workflowEntries = workflow ? Object.entries(workflow) : graphOnlyNodes;

  for (const [nodeId, nodeData] of workflowEntries) {
    if (!isRecord(nodeData)) continue;
    if (nodeData.mode === 2 || nodeData.mode === 4) continue;
    if (workflow) {
      const graphMode = resolveGraphNode(graphData, nodeId)?.mode;
      if (graphMode === 2 || graphMode === 4) continue;
    }

    const nodeInputs = isRecord(nodeData.inputs) ? nodeData.inputs : {};
    const classType =
      typeof nodeData.class_type === "string" ? nodeData.class_type : undefined;
    const nodeTitle = resolveNodeTitle(nodeId, nodeData, graphData, objectInfo);
    const classInfo = resolveClassInfo(objectInfo, classType);
    const inputSpec = resolveInputSpec(classInfo);
    const candidateParams = new Set<string>();

    for (const param of getOrderedObjectInfoParams(inputSpec, classInfo)) {
      const definition = resolveParamDefinition(inputSpec, param);
      const graphMode = resolveGraphWidgetMode(
        graphData,
        nodeId,
        param,
        classInfo,
        definition?.[1] ?? {},
      );
      if (
        shouldIncludeObjectInfoWidget(
          param,
          nodeTitle,
          classType,
          definition,
          graphMode,
        )
      ) {
        candidateParams.add(param);
      }
    }

    for (const param of Object.keys(nodeInputs)) {
      if (isManualWidgetParam(param, nodeTitle)) {
        candidateParams.add(param);
      }
    }

    const surfacedParams = new Set<string>();
    for (const param of candidateParams) {
      const definition = resolveParamDefinition(inputSpec, param);
      const typeSpec = definition?.[0];
      const opts = definition?.[1] ?? {};
      const graphValue = resolveGraphWidgetValue(graphData, nodeId, param, classInfo);
      const graphMode = resolveGraphWidgetMode(
        graphData,
        nodeId,
        param,
        classInfo,
        opts,
      );
      const defaultValue = hasOwnProperty(opts, "default") ? opts.default : undefined;
      const rawValue = hasOwnProperty(nodeInputs, param)
        ? nodeInputs[param]
        : graphValue ?? defaultValue;

      if (isLinkValue(rawValue)) {
        continue;
      }

      if (
        rawValue === undefined &&
        defaultValue === undefined &&
        graphValue === undefined
      ) {
        continue;
      }

      const explicitValueType = definition
        ? getWidgetValueTypeFromTypeSpec(typeSpec, opts)
        : null;
      const valueType =
        explicitValueType ?? inferWidgetValueType(rawValue ?? defaultValue);
      const options = coerceWidgetOptions(typeSpec, opts);
      const label = param === "value" ? nodeTitle : param;
      const supportsRandomize =
        hasControlAfterGenerate(opts) ||
        isManualWidgetParam(param, nodeTitle);

      widgets.push({
        nodeId,
        param,
        currentValue: rawValue ?? defaultValue ?? null,
        config: {
          label,
          controlAfterGenerate: supportsRandomize,
          defaultRandomize:
            graphMode === "randomize"
              ? true
              : graphMode
                ? false
                : undefined,
          defaultValue,
          nodeTitle,
          valueType: valueType ?? "unknown",
          min: typeof opts.min === "number" ? opts.min : undefined,
          max: typeof opts.max === "number" ? opts.max : undefined,
          step: typeof opts.step === "number" ? opts.step : undefined,
          options,
        },
      });
      surfacedParams.add(param);
    }

    appendFallbackWidgets({
      widgets,
      nodeId,
      nodeTitle,
      classType,
      graphData,
      surfacedParams,
    });
  }

  return widgets;
}

function appendFallbackWidgets(args: {
  widgets: WorkflowWidgetInput[];
  nodeId: string;
  nodeTitle: string;
  classType: string | undefined;
  graphData: Record<string, unknown> | null;
  surfacedParams: Set<string>;
}): void {
  const { widgets, nodeId, nodeTitle, classType, graphData, surfacedParams } =
    args;
  const slots = buildFallbackWidgetSlots(classType);
  if (slots.length === 0) return;

  const graphNode = resolveGraphNode(graphData, nodeId);
  const rawWidgetsValues = graphNode?.widgets_values;
  const widgetsValues = Array.isArray(rawWidgetsValues)
    ? rawWidgetsValues
    : null;

  for (const slot of slots) {
    if (surfacedParams.has(slot.name)) continue;

    const value =
      widgetsValues && slot.slot < widgetsValues.length
        ? widgetsValues[slot.slot]
        : undefined;
    const modeCandidate =
      slot.controlAfterGenerate &&
      widgetsValues &&
      slot.slot + 1 < widgetsValues.length
        ? widgetsValues[slot.slot + 1]
        : undefined;
    const mode =
      typeof modeCandidate === "string" &&
      CONTROL_MODE_VALUES.has(modeCandidate)
        ? (modeCandidate as "fixed" | "randomize" | "increment" | "decrement")
        : null;

    const isSeed = isSeedWidgetParam(slot.name);
    const isRandomize = mode === "randomize";
    // Surface seed/noise_seed unconditionally (matches isManualWidgetParam
    // behavior) and any other control widget only when its current mode is
    // randomize. Fixed-mode non-seed widgets stay hidden, matching the
    // primary discovery's policy.
    if (!isSeed && !isRandomize) continue;

    widgets.push({
      nodeId,
      param: slot.name,
      currentValue: value ?? null,
      config: {
        label: slot.name === "value" ? nodeTitle : slot.name,
        controlAfterGenerate: slot.controlAfterGenerate,
        defaultRandomize:
          mode === "randomize" ? true : mode ? false : undefined,
        defaultValue: undefined,
        nodeTitle,
        valueType: inferWidgetValueType(value ?? null),
      },
    });
    surfacedParams.add(slot.name);
  }
}
