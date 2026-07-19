import type { ExtensionContextKeyExpression, JsonValue } from "@vlo/extension-sdk";
import { jsonValueSchema } from "./jsonValue";

// Dotted, camelCase-friendly key names ("project.open", "selection.clipCount").
const CONTEXT_KEY_PATTERN = /^[a-z0-9]+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

/**
 * Validates an extension-supplied `when` expression at registration time so a
 * malformed clause fails activation loudly instead of silently disabling a
 * command forever. Depth is bounded because expressions are data an extension
 * package ships, not values computed at runtime.
 */
export function assertContextKeyExpression(
  expression: unknown,
  label: string,
  depth = 0,
): asserts expression is ExtensionContextKeyExpression {
  if (depth > 8) {
    throw new Error(`${label} 'when' expression nests too deeply.`);
  }
  if (typeof expression !== "object" || expression === null) {
    throw new Error(`${label} 'when' expression must be an object.`);
  }
  const clause = expression as Record<string, unknown>;
  const operators = ["key", "not", "and", "or"].filter(
    (operator) => operator in clause,
  );
  if (operators.length !== 1) {
    throw new Error(
      `${label} 'when' expression must use exactly one of key/not/and/or.`,
    );
  }
  if ("equals" in clause && operators[0] !== "key") {
    throw new Error(`${label} 'when' 'equals' is only valid beside 'key'.`);
  }
  if ("key" in clause) {
    if (
      typeof clause.key !== "string" ||
      !CONTEXT_KEY_PATTERN.test(clause.key)
    ) {
      throw new Error(`${label} 'when' clause has an invalid context key.`);
    }
    if ("equals" in clause && !jsonValueSchema.safeParse(clause.equals).success) {
      throw new Error(`${label} 'when' clause 'equals' must be finite JSON.`);
    }
    return;
  }
  if ("not" in clause) {
    assertContextKeyExpression(clause.not, label, depth + 1);
    return;
  }
  const branches = (clause.and ?? clause.or) as unknown;
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error(`${label} 'when' and/or requires a non-empty array.`);
  }
  for (const branch of branches) {
    assertContextKeyExpression(branch, label, depth + 1);
  }
}

function jsonEquals(left: JsonValue | undefined, right: JsonValue): boolean {
  if (left === undefined) return false;
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Pure evaluation over a key lookup. Fails closed: any structurally invalid
 * clause evaluates to false rather than throwing on a hot path.
 */
export function evaluateContextKeyExpression(
  expression: ExtensionContextKeyExpression,
  get: (key: string) => JsonValue | undefined,
): boolean {
  if (typeof expression !== "object" || expression === null) return false;
  if ("key" in expression) {
    const value = get(expression.key);
    if ("equals" in expression) return jsonEquals(value, expression.equals);
    return Boolean(value);
  }
  if ("not" in expression) {
    return !evaluateContextKeyExpression(expression.not, get);
  }
  if ("and" in expression) {
    return (
      Array.isArray(expression.and) &&
      expression.and.every((branch) =>
        evaluateContextKeyExpression(branch, get),
      )
    );
  }
  if ("or" in expression) {
    return (
      Array.isArray(expression.or) &&
      expression.or.some((branch) => evaluateContextKeyExpression(branch, get))
    );
  }
  return false;
}

/**
 * Host-published context keys consumed by declarative `when` clauses on
 * commands and keybindings. Keys are host-curated exactly like UI slots:
 * extensions read them, only host publishers write them.
 */
export class HostContextKeyService {
  private readonly values = new Map<string, JsonValue>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  /** Host-only. `undefined` clears the key; unchanged primitives are no-ops. */
  set(key: string, value: JsonValue | undefined): void {
    if (!CONTEXT_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid host context key '${key}'.`);
    }
    if (value === undefined) {
      if (!this.values.delete(key)) return;
    } else {
      const previous = this.values.get(key);
      if (this.values.has(key) && Object.is(previous, value)) return;
      if (!jsonValueSchema.safeParse(value).success) {
        throw new Error(`Host context key '${key}' must be finite JSON.`);
      }
      this.values.set(key, structuredClone(value));
    }
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Context observers are derived notifications only.
      }
    }
  }

  get(key: string): JsonValue | undefined {
    const value = this.values.get(key);
    return typeof value === "object" && value !== null
      ? structuredClone(value)
      : value;
  }

  evaluate(expression: ExtensionContextKeyExpression): boolean {
    return evaluateContextKeyExpression(expression, (key) =>
      this.values.get(key),
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }
}

export const hostContextKeys = new HostContextKeyService();
