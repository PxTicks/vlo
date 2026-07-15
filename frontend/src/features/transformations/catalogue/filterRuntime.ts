import { Filter } from "pixi.js";
import type {
  TransformationDefinition,
  TransformationFilterConstructor,
  TransformationFilterRuntime,
  TransformationFilterUpdateContext,
} from "./types";

/**
 * Adapter input for the host-owned filter runtime. Native implementations can
 * use this directly; extension integration supplies another adapter at its
 * boundary without changing the core applicator contract.
 */
export interface TransformationFilterRuntimeAdapter {
  create(): Filter | null;
  update(
    filter: Filter,
    parameters: Readonly<Record<string, unknown>>,
    context: TransformationFilterUpdateContext,
    outputFilters: Filter[],
  ): boolean;
  release(filter: Filter): void;
  dispose?(): void;
}

interface FilterRuntimeOwner {
  readonly token: symbol;
  readonly transformId: string;
  readonly release: () => void;
}

const FILTER_RUNTIME_OWNERS = new WeakMap<Filter, FilterRuntimeOwner>();
const CLASS_RUNTIMES = new WeakMap<
  TransformationDefinition,
  TransformationFilterRuntime
>();

/**
 * Build the canonical transform-keyed runtime used by native and adapted
 * filters. Ownership is recorded centrally so every renderer path can release
 * a filter without knowing whether its implementation is built-in or supplied
 * by an extension.
 */
export function createTransformationFilterRuntime(
  adapter: TransformationFilterRuntimeAdapter,
): TransformationFilterRuntime {
  const token = Symbol("transformation-filter-runtime");
  // Runtimes with global disposal (notably extension registrations) need a
  // strong list so dispose can release every instance. Ordinary native class
  // runtimes have application lifetime and rely on target teardown; keeping
  // their instances strongly here would prevent normal garbage collection.
  const liveFilters = adapter.dispose ? new Set<Filter>() : null;
  let disposed = false;

  const runtime: TransformationFilterRuntime = {
    create: (transformId) => {
      if (disposed) return null;
      const filter = adapter.create();
      if (!filter) return null;
      if (FILTER_RUNTIME_OWNERS.has(filter)) {
        adapter.release(filter);
        return null;
      }
      liveFilters?.add(filter);
      FILTER_RUNTIME_OWNERS.set(filter, {
        token,
        transformId,
        release: () => runtime.release(filter),
      });
      return filter;
    },
    matches: (filter, transformId) => {
      const owner = FILTER_RUNTIME_OWNERS.get(filter);
      return owner?.token === token && owner.transformId === transformId;
    },
    owns: (filter) => FILTER_RUNTIME_OWNERS.get(filter)?.token === token,
    update: (filter, parameters, context, outputFilters) => {
      const updated = adapter.update(
        filter,
        parameters,
        context,
        outputFilters,
      );
      if (!updated) runtime.release(filter);
      return updated;
    },
    release: (filter) => {
      if (FILTER_RUNTIME_OWNERS.get(filter)?.token !== token) return;
      FILTER_RUNTIME_OWNERS.delete(filter);
      liveFilters?.delete(filter);
      adapter.release(filter);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const filter of [...(liveFilters ?? [])]) runtime.release(filter);
      adapter.dispose?.();
    },
  };

  return Object.freeze(runtime);
}

function createClassFilterRuntime(
  FilterClass: TransformationFilterConstructor,
): TransformationFilterRuntime {
  return createTransformationFilterRuntime({
    create: () => new FilterClass(),
    update: (filter, parameters, _context, outputFilters) => {
      for (const [key, value] of Object.entries(parameters)) {
        // Pixi filter packages expose heterogeneous writable parameter fields.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (filter as any)[key] = value;
      }
      outputFilters.push(filter);
      return true;
    },
    release: (filter) => filter.destroy(),
  });
}

/** Resolve a definition's advanced runtime or its native FilterClass adapter. */
export function getTransformationFilterRuntime(
  definition: TransformationDefinition,
): TransformationFilterRuntime | null {
  if (definition.filterRuntime) return definition.filterRuntime;
  if (!definition.FilterClass) return null;

  let runtime = CLASS_RUNTIMES.get(definition);
  if (!runtime) {
    runtime = createClassFilterRuntime(definition.FilterClass);
    CLASS_RUNTIMES.set(definition, runtime);
  }
  return runtime;
}

/** Release a filter through its host runtime, regardless of implementation. */
export function releaseTransformationFilter(filter: Filter): boolean {
  const owner = FILTER_RUNTIME_OWNERS.get(filter);
  if (!owner) return false;
  owner.release();
  return true;
}

/** Release and detach every transformation filter owned by a render target. */
export function releaseTransformationFilters(target: {
  filters?: readonly Filter[] | Filter | null;
}): void {
  const filters = target.filters;
  const filterList = Array.isArray(filters) ? filters : filters ? [filters] : [];
  for (const filter of filterList) {
    if (!releaseTransformationFilter(filter)) filter.destroy();
  }
  target.filters = null;
}
