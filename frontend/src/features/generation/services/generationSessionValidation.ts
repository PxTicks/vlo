import { serializeFiniteJson } from "../utils/finiteJson";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationSessionJsonValue,
  GenerationSessionSnapshot,
  GenerationTransactionFailureCode,
  GenerationWidgetTarget,
} from "./generationSessionTypes";

/**
 * Deterministic validation for session transactions
 * (docs/generation-native-extension-seams-plan.md §3.2). Pure: a command is
 * judged against a published snapshot only, so the same command validates the
 * same way for a native control and for a trusted adapter.
 */

export interface ValidationFailure {
  readonly code: GenerationTransactionFailureCode;
  readonly message: string;
}

export type ValidationResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: ValidationFailure };

function failure(
  code: GenerationTransactionFailureCode,
  message: string,
): ValidationResult<never> {
  return { ok: false, failure: { code, message } };
}

export function widgetKey(target: GenerationWidgetTarget): string {
  return JSON.stringify([target.nodeId, target.widget]);
}

export function describeWidgetTarget(target: GenerationWidgetTarget): string {
  return `${target.nodeId}.${target.widget}`;
}

/** Editable widgets indexed by target; a key may bind more than one control. */
export function indexEditableWidgets(
  widgets: readonly GenerationEditableWidgetSnapshot[],
): Map<string, GenerationEditableWidgetSnapshot[]> {
  const index = new Map<string, GenerationEditableWidgetSnapshot[]>();
  for (const widget of widgets) {
    const key = widgetKey(widget.target);
    const existing = index.get(key);
    if (existing) {
      existing.push(widget);
    } else {
      index.set(key, [widget]);
    }
  }
  return index;
}

function catalogueHasTarget(
  snapshot: GenerationSessionSnapshot,
  target: GenerationWidgetTarget,
): boolean {
  return snapshot.workflow.nodes.some(
    (node) =>
      node.id === target.nodeId &&
      node.widgets.some((widget) => widget.param === target.widget),
  );
}

const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const NUMERIC_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

// Slider tracks and float widgets both produce values built from `step`
// arithmetic, which lands a hair outside an exact bound often enough to matter.
const RANGE_EPSILON = 1e-9;

function withinRange(
  value: number,
  widget: GenerationEditableWidgetSnapshot,
): boolean {
  if (widget.min !== null && value < widget.min - RANGE_EPSILON) return false;
  if (widget.max !== null && value > widget.max + RANGE_EPSILON) return false;
  return true;
}

function matchesOption(
  value: GenerationSessionJsonValue,
  options: readonly (string | number | boolean)[],
): boolean {
  return options.some(
    (option) =>
      option === value ||
      (typeof value !== "object" && String(option) === String(value)),
  );
}

/**
 * Is `value` acceptable for one editable binding?
 *
 * Numeric widgets also accept text, because that is what the panel's own
 * numeric fields emit: an in-progress or cleared field is the raw string, and
 * seeds beyond `Number.MAX_SAFE_INTEGER` stay strings on purpose so their
 * precision survives the round trip. Text that parses to a number is still
 * range-checked; text that does not parse at all is rejected.
 */
function acceptsValue(
  widget: GenerationEditableWidgetSnapshot,
  value: GenerationSessionJsonValue,
): ValidationFailure | null {
  const describe = describeWidgetTarget(widget.target);

  switch (widget.valueType) {
    case "enum": {
      if (!widget.options || widget.options.length === 0) {
        return typeof value === "object"
          ? {
              code: "widget_value_invalid",
              message: `Widget '${describe}' takes a scalar value.`,
            }
          : null;
      }
      return matchesOption(value, widget.options)
        ? null
        : {
            code: "widget_value_invalid",
            message: `Widget '${describe}' does not offer the option ${JSON.stringify(
              value,
            )}.`,
          };
    }
    case "boolean": {
      if (typeof value === "boolean") return null;
      if (value === "true" || value === "false") return null;
      if (widget.trueValue !== null && value === widget.trueValue) return null;
      if (widget.falseValue !== null && value === widget.falseValue) {
        return null;
      }
      return {
        code: "widget_value_invalid",
        message: `Widget '${describe}' takes a boolean value.`,
      };
    }
    case "int":
    case "float": {
      const isInt = widget.valueType === "int";
      if (typeof value === "number") {
        if (isInt && !Number.isInteger(value)) {
          return {
            code: "widget_value_invalid",
            message: `Widget '${describe}' takes a whole number.`,
          };
        }
        return withinRange(value, widget)
          ? null
          : {
              code: "widget_value_invalid",
              message: `Widget '${describe}' takes values between ${
                widget.min ?? "-∞"
              } and ${widget.max ?? "∞"}.`,
            };
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) return null;
        if (isInt ? !INTEGER_TEXT.test(value) : !NUMERIC_TEXT.test(value)) {
          return {
            code: "widget_value_invalid",
            message: `Widget '${describe}' takes a ${
              isInt ? "whole number" : "number"
            }.`,
          };
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) && !withinRange(parsed, widget)
          ? {
              code: "widget_value_invalid",
              message: `Widget '${describe}' takes values between ${
                widget.min ?? "-∞"
              } and ${widget.max ?? "∞"}.`,
            }
          : null;
      }
      return {
        code: "widget_value_invalid",
        message: `Widget '${describe}' takes a number.`,
      };
    }
    case "string": {
      return typeof value === "string"
        ? null
        : {
            code: "widget_value_invalid",
            message: `Widget '${describe}' takes a string.`,
          };
    }
    default:
      // An undeclared widget kind (no object_info, custom class): the graph
      // bridge is the only thing that can judge the value.
      return null;
  }
}

/**
 * Resolve an input id. Panel controls address an input by its bare node id
 * whenever that node has exactly one input — the same alias rule
 * `buildWorkflowInputLookup` applies — so the session accepts both forms and
 * commits the canonical `<nodeId>:<param>` id.
 */
function resolveInput(
  snapshot: GenerationSessionSnapshot,
  inputId: string,
): GenerationSessionSnapshot["inputs"][number] | null {
  const exact = snapshot.inputs.find((candidate) => candidate.id === inputId);
  if (exact) return exact;
  const byNodeId = snapshot.inputs.filter(
    (candidate) => candidate.nodeId === inputId,
  );
  return byNodeId.length === 1 ? byNodeId[0] : null;
}

export function validateTextInputCommand(
  snapshot: GenerationSessionSnapshot,
  inputId: string,
): ValidationResult<string> {
  const input = resolveInput(snapshot, inputId);
  if (!input) {
    return failure(
      "input_not_found",
      `Generation input '${inputId}' was not found.`,
    );
  }
  if (input.inputType !== "text") {
    return failure(
      "input_type_mismatch",
      `Generation input '${inputId}' is not a text input.`,
    );
  }
  return { ok: true, value: input.id };
}

export function validateWidgetCommand(
  snapshot: GenerationSessionSnapshot,
  editableIndex: ReadonlyMap<string, GenerationEditableWidgetSnapshot[]>,
  target: GenerationWidgetTarget,
  value: unknown,
): ValidationResult<GenerationSessionJsonValue> {
  const serialized = serializeFiniteJson(value);
  if (serialized === null) {
    return failure(
      "widget_value_invalid",
      `Widget '${describeWidgetTarget(
        target,
      )}' takes a value representable as finite JSON.`,
    );
  }
  const normalized = JSON.parse(serialized) as GenerationSessionJsonValue;

  const bindings = editableIndex.get(widgetKey(target));
  if (!bindings || bindings.length === 0) {
    return catalogueHasTarget(snapshot, target)
      ? failure(
          "widget_not_editable",
          `Widget '${describeWidgetTarget(
            target,
          )}' exists in the workflow but the generation panel exposes no control for it.`,
        )
      : failure(
          "widget_not_found",
          `Widget '${describeWidgetTarget(
            target,
          )}' was not found in the mounted workflow.`,
        );
  }

  // The same target can back more than one control (a raw widget and a derived
  // one, say). Accept when any binding accepts; report the first refusal
  // otherwise, so the message names a real constraint.
  let firstFailure: ValidationFailure | null = null;
  for (const binding of bindings) {
    const rejection = acceptsValue(binding, normalized);
    if (!rejection) {
      return { ok: true, value: normalized };
    }
    firstFailure ??= rejection;
  }
  return {
    ok: false,
    failure: firstFailure ?? {
      code: "widget_value_invalid",
      message: `Widget '${describeWidgetTarget(target)}' rejected the value.`,
    },
  };
}

/** Does the snapshot already hold this widget value? */
export function widgetValueMatchesSnapshot(
  editableIndex: ReadonlyMap<string, GenerationEditableWidgetSnapshot[]>,
  target: GenerationWidgetTarget,
  value: GenerationSessionJsonValue,
): boolean {
  const bindings = editableIndex.get(widgetKey(target));
  if (!bindings || bindings.length === 0) return false;
  const serialized = serializeFiniteJson(value);
  return bindings.every(
    (binding) => serializeFiniteJson(binding.value) === serialized,
  );
}
