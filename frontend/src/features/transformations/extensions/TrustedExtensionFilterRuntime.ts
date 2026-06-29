import { Filter } from "pixi.js";
import type { ExtensionTrustedFilterTransformationDefinition } from "../../extensions/types";
import type {
  ClipTransformTarget,
  TransformationFilterFactory,
} from "../catalogue/types";

interface TrustedFilterRecord {
  readonly factory: TransformationFilterFactory;
  readonly filter: Filter;
  readonly instance: ReturnType<
    ExtensionTrustedFilterTransformationDefinition["createFilter"]
  >;
  target?: ClipTransformTarget;
  released: boolean;
}

const TRUSTED_FILTER_RECORDS = new WeakMap<Filter, TrustedFilterRecord>();

type ReportFailureOnce = (
  key: string,
  level: "error" | "warning",
  message: string,
  detail?: unknown,
) => void;

function removeFromTarget(record: TrustedFilterRecord): void {
  const target = record.target as
    | { filters?: readonly Filter[] | null }
    | undefined;
  if (!target?.filters?.includes(record.filter)) return;
  target.filters = target.filters.filter((filter) => filter !== record.filter);
}

export function createTrustedExtensionFilterFactory(
  contributionId: string,
  definition: ExtensionTrustedFilterTransformationDefinition,
  reportFailureOnce: ReportFailureOnce,
): TransformationFilterFactory {
  const contributionRecords = new Set<TrustedFilterRecord>();
  let disposed = false;

  const factory: TransformationFilterFactory = {
    contributionId,
    create: () => {
      if (disposed) {
        throw new Error(
          `Trusted filter '${contributionId}' was used after disposal.`,
        );
      }
      const instance = definition.createFilter();
      if (
        typeof instance !== "object" ||
        instance === null ||
        !(instance.filter instanceof Filter) ||
        typeof instance.update !== "function"
      ) {
        if (
          typeof instance === "object" &&
          instance !== null &&
          typeof instance.destroy === "function"
        ) {
          try {
            instance.destroy();
          } catch (error) {
            reportFailureOnce(
              "invalid-trusted-filter-destroy",
              "error",
              `Trusted filter '${contributionId}' failed to clean up an invalid instance.`,
              error,
            );
          }
        }
        throw new Error(
          `Trusted filter '${contributionId}' must return a host Pixi Filter and update callback.`,
        );
      }
      if (TRUSTED_FILTER_RECORDS.has(instance.filter)) {
        throw new Error(
          `Trusted filter '${contributionId}' returned an instance that is already in use.`,
        );
      }
      const record: TrustedFilterRecord = {
        factory,
        filter: instance.filter,
        instance,
        released: false,
      };
      contributionRecords.add(record);
      TRUSTED_FILTER_RECORDS.set(record.filter, record);
      return record.filter;
    },
    owns: (filter) => TRUSTED_FILTER_RECORDS.get(filter)?.factory === factory,
    update: (filter, parameters, context) => {
      const record = TRUSTED_FILTER_RECORDS.get(filter);
      if (!record || record.factory !== factory || record.released) {
        throw new Error(
          `Trusted filter '${contributionId}' received an unknown instance.`,
        );
      }
      record.target = context.target;
      record.instance.update(parameters, context);
    },
    release: (filter) => {
      const record = TRUSTED_FILTER_RECORDS.get(filter);
      if (!record || record.factory !== factory || record.released) return;
      record.released = true;
      removeFromTarget(record);
      contributionRecords.delete(record);
      TRUSTED_FILTER_RECORDS.delete(record.filter);
      try {
        record.instance.destroy?.();
      } catch (error) {
        reportFailureOnce(
          "trusted-filter-instance-destroy",
          "error",
          `Trusted filter '${contributionId}' failed to release extension-owned resources.`,
          error,
        );
      }
      try {
        record.filter.destroy();
      } catch (error) {
        reportFailureOnce(
          "trusted-filter-pixi-destroy",
          "error",
          `Trusted filter '${contributionId}' failed to destroy its Pixi filter.`,
          error,
        );
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const record of [...contributionRecords]) {
        factory.release(record.filter);
      }
    },
  };

  return Object.freeze(factory);
}

export function releaseTrustedExtensionFilter(filter: Filter): boolean {
  const record = TRUSTED_FILTER_RECORDS.get(filter);
  if (!record) return false;
  record.factory.release(filter);
  return true;
}
