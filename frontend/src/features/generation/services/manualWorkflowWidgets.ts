import type { WidgetValueType, WorkflowWidgetInput } from "../types";
import { isRecord } from "./parsers";

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

function normalizeNodeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
): string {
  const meta = isRecord(node._meta) ? node._meta : null;
  const graphNode = resolveGraphNode(graphData, nodeId);

  return (
    normalizeNodeName(meta?.title) ??
    normalizeNodeName(graphNode?.title) ??
    normalizeNodeName(graphNode?.type) ??
    normalizeNodeName(node.class_type) ??
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

function resolveClassInfo(
  objectInfo: Record<string, unknown> | null,
  classType: string | undefined,
): Record<string, unknown> | null {
  if (!objectInfo || !classType) return null;
  const classInfo = objectInfo[classType];
  return isRecord(classInfo) ? classInfo : null;
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
    index += opts.control_after_generate === true ? 2 : 1;
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
  if (opts.control_after_generate !== true) return null;

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
    return isSeedWidgetParam(param) || graphMode === "randomize";
  }

  return opts.control_after_generate === true || isManualWidgetParam(param, nodeTitle);
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
        const nodeId = String(node.id);
        const classType = typeof node.type === "string" ? node.type : undefined;
        return [[
          nodeId,
          {
            class_type: classType,
            inputs: {},
            _meta: {
              title:
                typeof node.title === "string"
                  ? node.title
                  : classType ?? `Node ${nodeId}`,
            },
          },
        ] as const];
      })
    : [];
  const workflowEntries = workflow ? Object.entries(workflow) : graphOnlyNodes;

  for (const [nodeId, nodeData] of workflowEntries) {
    if (!isRecord(nodeData)) continue;

    const nodeInputs = isRecord(nodeData.inputs) ? nodeData.inputs : {};
    const classType =
      typeof nodeData.class_type === "string" ? nodeData.class_type : undefined;
    const nodeTitle = resolveNodeTitle(nodeId, nodeData, graphData);
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
        opts.control_after_generate === true || isSeedWidgetParam(param);

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
    }
  }

  return widgets;
}
