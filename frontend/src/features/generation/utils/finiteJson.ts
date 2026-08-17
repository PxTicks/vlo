/**
 * Stable, strict JSON serialization: object keys are sorted so semantically
 * equal values compare equal, and anything JSON cannot represent faithfully
 * (undefined, functions, symbols, bigints, non-finite numbers, cycles)
 * returns `null` instead of being silently coerced.
 *
 * Shared by normalized graph effects (queue capture) and the generation
 * session service (transaction validation) so both agree on which values a
 * widget write may carry.
 */
export function serializeFiniteJson(value: unknown): string | null {
  const seen = new Set<object>();

  function serialize(current: unknown): string | null {
    if (current === null) {
      return "null";
    }
    switch (typeof current) {
      case "string":
      case "boolean":
        return JSON.stringify(current);
      case "number":
        return Number.isFinite(current) ? JSON.stringify(current) : null;
      case "object":
        break;
      default:
        return null;
    }

    const objectValue = current as object;
    if (seen.has(objectValue)) {
      return null;
    }
    seen.add(objectValue);

    let result: string | null;
    if (Array.isArray(objectValue)) {
      const parts: string[] = [];
      result = "";
      for (const item of objectValue) {
        const part = serialize(item);
        if (part === null) {
          result = null;
          break;
        }
        parts.push(part);
      }
      if (result !== null) {
        result = `[${parts.join(",")}]`;
      }
    } else {
      const record = objectValue as Record<string, unknown>;
      const parts: string[] = [];
      result = "";
      for (const key of Object.keys(record).sort()) {
        const part = serialize(record[key]);
        if (part === null) {
          result = null;
          break;
        }
        parts.push(`${JSON.stringify(key)}:${part}`);
      }
      if (result !== null) {
        result = `{${parts.join(",")}}`;
      }
    }

    seen.delete(objectValue);
    return result;
  }

  return serialize(value);
}
