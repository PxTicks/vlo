export type Draft<T> = T;

export type PatchOperation = "add" | "remove" | "replace";

export interface Patch {
  op: PatchOperation;
  path: Array<string | number>;
  value?: unknown;
}

export function enablePatches(): void {
  // No-op for this lightweight implementation.
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isObject(value: unknown): value is Record<string | number, unknown> {
  return value !== null && typeof value === "object";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

function buildRootPatches<T extends object>(
  base: T,
  next: T,
): { patches: Patch[]; inversePatches: Patch[] } {
  const patches: Patch[] = [];
  const inversePatches: Patch[] = [];

  const keySet = new Set<string>([
    ...Object.keys(base as Record<string, unknown>),
    ...Object.keys(next as Record<string, unknown>),
  ]);

  for (const key of keySet) {
    const hasBase = Object.prototype.hasOwnProperty.call(base, key);
    const hasNext = Object.prototype.hasOwnProperty.call(next, key);

    if (!hasBase && hasNext) {
      patches.push({
        op: "add",
        path: [key],
        value: cloneValue((next as Record<string, unknown>)[key]),
      });
      inversePatches.push({ op: "remove", path: [key] });
      continue;
    }

    if (hasBase && !hasNext) {
      patches.push({ op: "remove", path: [key] });
      inversePatches.push({
        op: "add",
        path: [key],
        value: cloneValue((base as Record<string, unknown>)[key]),
      });
      continue;
    }

    const baseValue = (base as Record<string, unknown>)[key];
    const nextValue = (next as Record<string, unknown>)[key];

    if (deepEqual(baseValue, nextValue)) continue;

    patches.push({
      op: "replace",
      path: [key],
      value: cloneValue(nextValue),
    });
    inversePatches.push({
      op: "replace",
      path: [key],
      value: cloneValue(baseValue),
    });
  }

  return { patches, inversePatches };
}

function resolveParent(
  target: unknown,
  path: Array<string | number>,
): { parent: Record<string | number, unknown> | unknown[]; key: string | number } {
  if (path.length === 0) {
    throw new Error("Root path patches are not supported.");
  }

  let current: unknown = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (!isObject(current) && !Array.isArray(current)) {
      throw new Error(`Patch path segment ${String(segment)} is not addressable.`);
    }

    const next = (current as Record<string | number, unknown>)[segment];
    if (next === undefined) {
      throw new Error(`Patch path segment ${String(segment)} does not exist.`);
    }
    current = next;
  }

  if (!isObject(current) && !Array.isArray(current)) {
    throw new Error("Patch parent is not addressable.");
  }

  return { parent: current as Record<string | number, unknown> | unknown[], key: path[path.length - 1] };
}

function applySinglePatch(target: unknown, patch: Patch): void {
  const { parent, key } = resolveParent(target, patch.path);

  if (Array.isArray(parent)) {
    if (typeof key !== "number") {
      throw new Error("Array patch key must be a number.");
    }

    if (patch.op === "remove") {
      parent.splice(key, 1);
      return;
    }

    if (patch.op === "add" && key === parent.length) {
      parent.push(cloneValue(patch.value));
      return;
    }

    parent[key] = cloneValue(patch.value);
    return;
  }

  if (patch.op === "remove") {
    delete parent[key];
    return;
  }

  parent[key] = cloneValue(patch.value);
}

export function produce<T>(base: T, recipe: (draft: Draft<T>) => void): T {
  const draft = cloneValue(base);
  recipe(draft);
  return draft;
}

export function produceWithPatches<T extends object>(
  base: T,
  recipe: (draft: Draft<T>) => void,
): [T, Patch[], Patch[]] {
  const next = produce(base, recipe);
  const { patches, inversePatches } = buildRootPatches(base, next);
  return [next, patches, inversePatches];
}

export function applyPatches<T>(base: T, patches: Patch[]): T {
  const draft = cloneValue(base) as unknown;
  patches.forEach((patch) => {
    applySinglePatch(draft, patch);
  });
  return draft as T;
}
