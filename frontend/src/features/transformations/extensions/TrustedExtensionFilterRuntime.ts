import { Filter } from "pixi.js";
import type {
  ExtensionTrustedFilterApplyContext,
  ExtensionTrustedFilterTransformationDefinition,
} from "../../extensions/types";
import {
  TrustedHostObjectManager,
  releaseTrustedHostObject,
  type TrustedHostObjectFailureReporter,
  type TrustedHostObjectSlotAdapter,
} from "../../extensions/runtime/publicApi";
import type {
  ClipTransformTarget,
  TransformationFilterFactory,
} from "../catalogue/types";

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

export function createTrustedExtensionFilterFactory(
  contributionId: string,
  definition: ExtensionTrustedFilterTransformationDefinition,
  reportFailureOnce: TrustedHostObjectFailureReporter,
): TransformationFilterFactory {
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

  const factory: TransformationFilterFactory = {
    contributionId,
    create: () => manager.create(),
    owns: (filter) => manager.owns(filter),
    update: (filter, parameters, context, outputFilters) =>
      manager.update(
        filter,
        parameters,
        context,
        context.target,
        outputFilters,
      ),
    release: (filter) => manager.release(filter),
    dispose: () => manager.dispose(),
  };
  return Object.freeze(factory);
}

export function releaseTrustedExtensionFilter(filter: Filter): boolean {
  return releaseTrustedHostObject(filter);
}
