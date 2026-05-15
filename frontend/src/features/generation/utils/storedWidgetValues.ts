import type { WorkflowWidgetInput } from "../types";

export function isUnsafeIntegerString(raw: string): boolean {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return false;
  try {
    const intValue = BigInt(trimmed);
    return (
      intValue > BigInt(Number.MAX_SAFE_INTEGER) ||
      intValue < BigInt(Number.MIN_SAFE_INTEGER)
    );
  } catch {
    return false;
  }
}

export function parseStoredWidgetValue(
  widget: WorkflowWidgetInput,
  storedValue: string,
): unknown {
  const valueType = widget.config.valueType;
  const fallbackValue = widget.currentValue;

  if (valueType === "boolean") {
    if (
      widget.config.trueValue !== undefined &&
      storedValue === String(widget.config.trueValue)
    ) {
      return true;
    }
    if (
      widget.config.falseValue !== undefined &&
      storedValue === String(widget.config.falseValue)
    ) {
      return false;
    }
  }

  const expectsInteger =
    valueType === "int" ||
    ((valueType == null || valueType === "unknown") &&
      typeof fallbackValue === "number" &&
      Number.isInteger(fallbackValue));
  const trimmed = storedValue.trim();
  if (expectsInteger && isUnsafeIntegerString(trimmed)) {
    return trimmed;
  }

  if (
    valueType === "int" ||
    valueType === "float" ||
    typeof fallbackValue === "number"
  ) {
    const parsed = Number(storedValue);
    return Number.isFinite(parsed) ? parsed : fallbackValue;
  }

  if (valueType === "boolean" || typeof fallbackValue === "boolean") {
    if (storedValue === "true") {
      return true;
    }
    if (storedValue === "false") {
      return false;
    }
    return fallbackValue;
  }

  return storedValue;
}
