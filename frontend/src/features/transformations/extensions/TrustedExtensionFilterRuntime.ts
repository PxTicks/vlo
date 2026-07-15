import { Filter } from "pixi.js";
import type {
  ExtensionTrustedFilterApplyContext,
  ExtensionTrustedFilterTransformationDefinition,
} from "../../extensions/types";
import {
  TrustedHostObjectManager,
  type TrustedHostObjectFailureReporter,
  type TrustedHostObjectSlotAdapter,
} from "../../extensions/runtime/publicApi";
import type {
  ClipTransformTarget,
  TransformationFilterRuntime,
} from "../catalogue/types";
import { createTransformationFilterRuntime } from "../catalogue/filterRuntime";

const FILTER_SLOT_ADAPTER: TrustedHostObjectSlotAdapter<
  Filter,
  ClipTransformTarget,
  Filter[]
> = {
  slotKind: "Pixi filter",
  validate: (object: object): object is Filter => object instanceof Filter,
  isSameSlot: (left, right) => left === right,
  attach: (filter, _target, outputFilters) => {
    outputFilters.push(filter);
  },
  detach: (filter, target) => {
    const mutableTarget = target as { filters?: readonly Filter[] | null };
    if (!mutableTarget.filters?.includes(filter)) return;
    mutableTarget.filters = mutableTarget.filters.filter(
      (candidate) => candidate !== filter,
    );
  },
  destroy: (filter) => filter.destroy(),
};

export function createTrustedExtensionFilterRuntime(
  contributionId: string,
  definition: ExtensionTrustedFilterTransformationDefinition,
  reportFailureOnce: TrustedHostObjectFailureReporter,
): TransformationFilterRuntime {
  const manager = new TrustedHostObjectManager<
    Filter,
    Readonly<Record<string, unknown>>,
    ExtensionTrustedFilterApplyContext,
    ClipTransformTarget,
    Filter[]
  >({
    contributionId,
    create: definition.createFilter,
    adapter: FILTER_SLOT_ADAPTER,
    reportFailureOnce,
  });

  // The native runtime owns transform identity and generic lifecycle. This
  // adapter contributes only the trusted extension object's implementation.
  return createTransformationFilterRuntime({
    create: () => manager.create(),
    update: (filter, parameters, context, outputFilters) =>
      manager.update(
        filter,
        parameters,
        context,
        context.target as ClipTransformTarget,
        outputFilters,
      ),
    release: (filter) => manager.release(filter),
    dispose: () => manager.dispose(),
  });
}
