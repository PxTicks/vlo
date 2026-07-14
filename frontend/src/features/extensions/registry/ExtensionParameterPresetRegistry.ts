import { COLOR_GRADE_FILTER_NAME } from "../../transformations/catalogue/filters/colorGrade";
import { extensionColorApi } from "../services/extensionColorApi";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "./ExtensionContributionRegistry";
import { cloneAndFreezeJsonValue, cloneFrozenJsonObject } from "./frozenJson";
import type {
  ExtensionApiScope,
  ExtensionParameterPresetDefinition,
  ExtensionParameterPresetRegistration,
  ExtensionParameterPresetTarget,
  JsonValue,
} from "../types";

/**
 * Validates and clamps a preset patch for one host target. The registry is
 * generic, but a target only becomes usable when the host declares its identity,
 * its schema, and a panel that consumes the registry — a preset must never reach
 * a transformation whose parameter contract nobody has adapted.
 */
type ParameterPresetTargetAdapter = (
  parameters: Readonly<Record<string, JsonValue>>,
) => Readonly<Record<string, JsonValue>>;

function targetKey(target: ExtensionParameterPresetTarget): string {
  return `${target.kind}:${target.filterName}`;
}

/**
 * V1 grade presets are static partial patches. `lutAssetId` is rejected because
 * an extension package cannot know a durable project asset ID; LUT-backed looks
 * belong to the LUT contribution flow, which ingests bytes as a project asset
 * first. Animated values, unknown fields, and synthetic UI keys are rejected by
 * the shared grade schema.
 */
const gradePresetAdapter: ParameterPresetTargetAdapter = (parameters) => {
  if ("lutAssetId" in parameters) {
    throw new Error(
      "A grade preset cannot set 'lutAssetId'. An extension package cannot know a project asset ID.",
    );
  }
  const normalized = extensionColorApi.grade.normalizePatch(parameters);
  return cloneAndFreezeJsonValue(
    structuredClone(normalized) as Record<string, JsonValue>,
  );
};

export const HOST_PARAMETER_PRESET_TARGETS: ReadonlyMap<
  string,
  ParameterPresetTargetAdapter
> = new Map([
  [
    targetKey({ kind: "filter", filterName: COLOR_GRADE_FILTER_NAME }),
    gradePresetAdapter,
  ],
]);

export interface RuntimeParameterPresetDefinition
  extends ExtensionContributionDefinition {
  readonly label: string;
  readonly target: ExtensionParameterPresetTarget;
  /** Normalized, deeply frozen partial patch. */
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly order: number;
}

export type RegisteredExtensionParameterPreset =
  RegisteredExtensionContribution<RuntimeParameterPresetDefinition>;

export class ExtensionParameterPresetRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeParameterPresetDefinition>(
      "parameter-preset",
    );

  bind(scope: ExtensionApiScope): {
    register(
      definition: ExtensionParameterPresetDefinition,
    ): ExtensionParameterPresetRegistration;
  } {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      register: (definition: ExtensionParameterPresetDefinition) => {
        // Compile first: an invalid preset fails activation rather than
        // publishing a patch the target panel would later apply.
        const registration = bound.register(this.compile(definition));
        return Object.freeze({
          id: registration.id,
          dispose: () => {
            void registration.dispose();
          },
        });
      },
    });
  }

  /** Presets contributed to one target, ordered deterministically. */
  list(
    target: ExtensionParameterPresetTarget,
  ): readonly RegisteredExtensionParameterPreset[] {
    const key = targetKey(target);
    return this.registry
      .list()
      .filter(
        (contribution) =>
          targetKey(contribution.definition.target) === key,
      )
      .sort(
        (left, right) =>
          left.definition.order - right.definition.order ||
          left.id.localeCompare(right.id),
      );
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }

  private compile(
    definition: ExtensionParameterPresetDefinition,
  ): RuntimeParameterPresetDefinition {
    if (definition.apiVersion !== 1) {
      throw new Error(`Parameter preset '${definition.id}' must use API 1.`);
    }
    if (
      typeof definition.label !== "string" ||
      definition.label.trim().length === 0
    ) {
      throw new Error(
        `Parameter preset '${definition.id}' must declare a label.`,
      );
    }
    const target = definition.target;
    if (typeof target !== "object" || target === null) {
      throw new Error(
        `Parameter preset '${definition.id}' must declare a target.`,
      );
    }
    const adapter = HOST_PARAMETER_PRESET_TARGETS.get(targetKey(target));
    if (!adapter) {
      throw new Error(
        `Parameter preset '${definition.id}' targets an unsupported transformation.`,
      );
    }
    const order = definition.order ?? 0;
    if (!Number.isFinite(order)) {
      throw new Error(
        `Parameter preset '${definition.id}' order must be finite.`,
      );
    }
    const parameters = cloneFrozenJsonObject(
      definition.parameters,
      `Parameter preset '${definition.id}' parameters`,
    );
    if (Object.keys(parameters).length === 0) {
      throw new Error(
        `Parameter preset '${definition.id}' must patch at least one parameter.`,
      );
    }

    return Object.freeze({
      id: definition.id,
      apiVersion: 1,
      label: definition.label.trim(),
      target: Object.freeze({ ...target }),
      parameters: adapter(parameters),
      order,
      execution: "trusted",
    });
  }
}

export const extensionParameterPresetRegistry =
  new ExtensionParameterPresetRegistry();
