import type { WidgetValueType } from "../types";
import { isRecord } from "./parsers";
import type { FlatGraphNode } from "./graphSubgraphs";

/**
 * ComfyUI `object_info` widget primitives shared by the panel's manual widget
 * discovery (`manualWorkflowWidgets`) and the session node/widget catalogue
 * (`workflowNodeCatalogue`). Both have to read widget slots, types, options,
 * ranges, and control modes the same way `graphToPrompt` does, so the parsing
 * lives here once.
 */

export type WidgetControlMode =
  | "fixed"
  | "randomize"
  | "increment"
  | "decrement";

export const CONTROL_MODE_VALUES: ReadonlySet<string> = new Set([
  "fixed",
  "randomize",
  "increment",
  "decrement",
]);

export function isPrimitiveOption(
  value: unknown,
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function isLinkValue(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2;
}

// `control_after_generate` in object_info appears as either `true` (e.g. KSampler's
// seed) or a string mode like `"fixed"` (e.g. PrimitiveInt's value). Either form
// means the widget occupies two slots in widgets_values: [value, mode]. Strict
// `=== true` checks miss the string form, causing PrimitiveInt-style widgets to
// be misaligned and their randomize state to go undetected.
export function hasControlAfterGenerate(opts: Record<string, unknown>): boolean {
  const value = opts.control_after_generate;
  if (value === true) return true;
  if (typeof value === "string" && CONTROL_MODE_VALUES.has(value)) return true;
  return false;
}

export function inferWidgetValueType(value: unknown): WidgetValueType {
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

export function coerceWidgetOptions(
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

/**
 * The widget kind a param's `object_info` type spec describes, or `null` when
 * the param is a link-only input (a node connection) rather than a widget.
 */
export function getWidgetValueTypeFromTypeSpec(
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

export function resolveInputSpec(
  classInfo: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const input = classInfo?.input;
  return isRecord(input) ? input : null;
}

export function resolveParamDefinition(
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

export function getOrderedObjectInfoParams(
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

/** Param → index into a node's `widgets_values`, mirroring ComfyUI's layout. */
export function getWidgetValueIndexMap(
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

export function resolveGraphWidgetValue(
  graphNode: FlatGraphNode | null,
  param: string,
  classInfo: Record<string, unknown> | null,
): unknown {
  if (!graphNode) return undefined;

  // A promoted widget's value lives on the enclosing subgraph instance node
  // and is what executes, even when the inner node still carries a different
  // (stale) value of its own.
  const promoted = graphNode.promotedValues.get(param);
  if (promoted !== undefined) return promoted;

  const widgetsValues = graphNode.node.widgets_values;
  if (!Array.isArray(widgetsValues)) return undefined;

  const widgetIndex = getWidgetValueIndexMap(classInfo).get(param);
  if (typeof widgetIndex !== "number") return undefined;
  return widgetsValues[widgetIndex];
}

// The control-after-generate mode is never promoted to the subgraph instance —
// only the value is — so it always comes from the node's own widgets_values.
export function resolveGraphWidgetMode(
  graphNode: FlatGraphNode | null,
  param: string,
  classInfo: Record<string, unknown> | null,
  opts: Record<string, unknown>,
): WidgetControlMode | null {
  if (!hasControlAfterGenerate(opts)) return null;
  if (!graphNode) return null;

  const widgetsValues = graphNode.node.widgets_values;
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
