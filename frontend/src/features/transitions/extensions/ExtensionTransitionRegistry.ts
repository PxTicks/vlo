import type {
  ExtensionApiScope,
  ExtensionTransitionApi,
  ExtensionTransitionColorLayer,
  ExtensionTransitionControl,
  ExtensionTransitionDefinition,
  ExtensionTransitionFrame,
  ExtensionTransitionRegistration,
  ExtensionTransitionSelectOption,
  ExtensionTransitionTransform,
  ExtensionTransitionZOrder,
  JsonValue,
} from "../../extensions/types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
} from "../../extensions/registry/ExtensionContributionRegistry";
import { toExtensionClipSnapshot } from "../../timeline/api";
import type { ClipTransform } from "../../../types/TimelineTypes";
import type {
  TransitionDefinition,
  TransitionFrameResult,
  TransitionRenderContext,
  TransitionZOrder,
} from "../catalogue/types";

interface RuntimeTransitionContribution
  extends ExtensionContributionDefinition {
  runtimeDefinition: TransitionDefinition;
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function assertText(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
}

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((entry) => isJsonValue(entry, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) =>
    isJsonValue(entry, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return (
    isJsonValue(value) &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function cloneAndFreezeJsonValue<TValue extends JsonValue>(
  value: TValue,
): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeJsonValue)) as TValue;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneAndFreezeJsonValue(entry),
        ]),
      ),
    ) as TValue;
  }
  return value;
}

function cloneJsonObject(
  value: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      cloneAndFreezeJsonValue(entry),
    ]),
  );
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]!))
    );
  }
  if (
    typeof left === "object" &&
    left !== null &&
    !Array.isArray(left) &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(right)
  ) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          jsonValuesEqual(left[key]!, right[key]!),
      )
    );
  }
  return false;
}

function validateControl(control: ExtensionTransitionControl): void {
  assertText(control.name, "Transition control name", 80);
  assertText(control.label, `Transition control '${control.name}' label`, 120);

  if (control.type === "slider" || control.type === "number") {
    if (
      !Number.isFinite(control.defaultValue) ||
      !Number.isFinite(control.min) ||
      !Number.isFinite(control.max) ||
      control.min > control.max ||
      control.defaultValue < control.min ||
      control.defaultValue > control.max
    ) {
      throw new Error(
        `Transition control '${control.name}' has invalid numeric bounds.`,
      );
    }
    if (
      control.step !== undefined &&
      (!Number.isFinite(control.step) || control.step <= 0)
    ) {
      throw new Error(
        `Transition control '${control.name}' step must be positive.`,
      );
    }
    return;
  }

  if (control.type === "checkbox") return;

  if (control.type === "text") {
    if (control.defaultValue.length > 10_000) {
      throw new Error(
        `Transition control '${control.name}' default text is too long.`,
      );
    }
    return;
  }

  if (control.type === "color") {
    if (!COLOR_PATTERN.test(control.defaultValue)) {
      throw new Error(
        `Transition control '${control.name}' must use a #RRGGBB color.`,
      );
    }
    return;
  }

  if (control.type === "select") {
    if (!Array.isArray(control.options) || control.options.length === 0) {
      throw new Error(
        `Transition control '${control.name}' must declare select options.`,
      );
    }
    for (const option of control.options) {
      assertText(
        option.label,
        `Transition control '${control.name}' option label`,
        120,
      );
    }
    if (
      !control.options.some((option) =>
        jsonValuesEqual(option.value, control.defaultValue),
      )
    ) {
      throw new Error(
        `Transition control '${control.name}' default must match an option.`,
      );
    }
  }
}

function isValidControlValue(
  value: unknown,
  control: ExtensionTransitionControl,
): boolean {
  if (control.type === "slider" || control.type === "number") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= control.min &&
      value <= control.max
    );
  }
  if (control.type === "checkbox") return typeof value === "boolean";
  if (control.type === "text") return typeof value === "string";
  if (control.type === "color") {
    return typeof value === "string" && COLOR_PATTERN.test(value);
  }
  if (control.type === "select") {
    return (
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") &&
      control.options.some((option) => jsonValuesEqual(option.value, value))
    );
  }
  return false;
}

function toRuntimeZOrder(
  zOrder: ExtensionTransitionZOrder | undefined,
): TransitionZOrder | undefined {
  if (
    zOrder === "default" ||
    zOrder === "outgoing-on-top" ||
    zOrder === "incoming-on-top"
  ) {
    return zOrder;
  }
  return undefined;
}

function toClipTransform(
  transitionId: string,
  side: "outgoing" | "incoming",
  transform: ExtensionTransitionTransform,
  index: number,
): ClipTransform {
  assertText(transform.type, "Transition transform type", 120);
  if (!isJsonObject(transform.parameters)) {
    throw new Error("Transition transform parameters must be a JSON object.");
  }
  const idPart =
    typeof transform.id === "string" && transform.id.trim().length > 0
      ? transform.id.trim()
      : String(index);
  return {
    id: `${transitionId}:extension:${side}:${idPart}`,
    type: transform.type.trim(),
    isEnabled: transform.isEnabled ?? true,
    parameters: cloneJsonObject(transform.parameters),
    ...(transform.templateId ? { templateId: transform.templateId } : {}),
    ...(transform.filterName ? { filterName: transform.filterName } : {}),
  };
}

function toColorLayer(
  transitionId: string,
  layer: ExtensionTransitionColorLayer,
  index: number,
) {
  if (!COLOR_PATTERN.test(layer.color)) {
    throw new Error("Transition color layers must use #RRGGBB colors.");
  }
  if (
    layer.zIndexOffset !== undefined &&
    !Number.isFinite(layer.zIndexOffset)
  ) {
    throw new Error("Transition color layer zIndexOffset must be finite.");
  }
  return {
    id:
      typeof layer.id === "string" && layer.id.trim().length > 0
        ? `${transitionId}:extension:color:${layer.id.trim()}`
        : `${transitionId}:extension:color:${index}`,
    color: layer.color,
    zIndexOffset: layer.zIndexOffset,
  };
}

function compileDefinition(
  ownerId: string,
  definition: ExtensionTransitionDefinition,
  report: ExtensionApiScope["report"],
): RuntimeTransitionContribution {
  if (definition.apiVersion !== 1) {
    throw new Error(`Transition '${definition.id}' must use apiVersion 1.`);
  }
  assertText(definition.label, `Transition '${definition.id}' label`, 120);
  assertText(definition.glyph, `Transition '${definition.id}' glyph`, 12);
  if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
    throw new Error(
      `Transition '${definition.id}' schemaVersion must be a positive integer.`,
    );
  }
  if (typeof definition.renderFrame !== "function") {
    throw new Error(`Transition '${definition.id}' must provide renderFrame.`);
  }

  const groupIds = new Set<string>();
  const controlsByName = new Map<string, ExtensionTransitionControl>();
  const groups = (definition.groups ?? []).map((group) => {
    assertText(group.id, "Transition UI group ID", 80);
    assertText(group.title, `Transition UI group '${group.id}' title`, 120);
    if (groupIds.has(group.id)) {
      throw new Error(`Duplicate transition UI group '${group.id}'.`);
    }
    groupIds.add(group.id);
    if (!Array.isArray(group.controls) || group.controls.length === 0) {
      throw new Error(
        `Transition UI group '${group.id}' must contain controls.`,
      );
    }
    if (
      group.columns !== undefined &&
      (!Number.isInteger(group.columns) ||
        group.columns < 1 ||
        group.columns > 4)
    ) {
      throw new Error(
        `Transition UI group '${group.id}' columns must be an integer from 1 to 4.`,
      );
    }

    const controls = group.controls.map((control) => {
      validateControl(control);
      if (controlsByName.has(control.name)) {
        throw new Error(`Duplicate transition parameter '${control.name}'.`);
      }
      const frozenControl =
        control.type === "select"
          ? Object.freeze({
              ...control,
              options: Object.freeze(
                control.options.map((option: ExtensionTransitionSelectOption) =>
                  Object.freeze({ ...option }),
                ),
              ),
            })
          : Object.freeze({ ...control });
      controlsByName.set(control.name, frozenControl);
      return frozenControl;
    });
    return Object.freeze({
      id: group.id,
      title: group.title,
      columns: group.columns,
      controls: Object.freeze(controls),
    });
  });

  const defaultParameters: Record<string, JsonValue> = {};
  for (const [name, control] of controlsByName) {
    defaultParameters[name] = cloneAndFreezeJsonValue(control.defaultValue);
  }
  if (definition.defaultParameters) {
    for (const [name, value] of Object.entries(definition.defaultParameters)) {
      if (!isJsonValue(value)) {
        throw new Error(
          `Transition '${definition.id}' default '${name}' must be JSON.`,
        );
      }
      defaultParameters[name] = cloneAndFreezeJsonValue(value);
    }
  }

  const contributionId = `${ownerId}/${definition.id}`;
  const reportedFailureKeys = new Set<string>();
  const reportFailureOnce = (
    key: string,
    message: string,
    detail?: unknown,
  ): void => {
    if (reportedFailureKeys.has(key) || reportedFailureKeys.size >= 500) {
      return;
    }
    reportedFailureKeys.add(key);
    report("error", message, detail);
  };

  const validateParameters = (
    parameters: Readonly<Record<string, unknown>>,
    schemaVersion: number,
  ): boolean => {
    if (schemaVersion !== definition.schemaVersion) return false;
    for (const [name, control] of controlsByName) {
      if (
        !Object.hasOwn(parameters, name) ||
        !isValidControlValue(parameters[name], control)
      ) {
        return false;
      }
    }
    if (!definition.validateParameters) {
      return true;
    }
    if (!isJsonObject(parameters)) return false;
    try {
      return definition.validateParameters(parameters, schemaVersion) === true;
    } catch (error) {
      reportFailureOnce(
        "parameter-validator",
        `Transition '${contributionId}' threw while validating parameters.`,
        error,
      );
      return false;
    }
  };

  if (!validateParameters(defaultParameters, definition.schemaVersion)) {
    throw new Error(
      `Transition '${definition.id}' has invalid default parameters.`,
    );
  }

  const migrateParameters = (
    parameters: Readonly<Record<string, unknown>>,
    schemaVersion: number,
  ): { parameters: Record<string, JsonValue>; schemaVersion: number } | null => {
    // Render-time migration keeps missing/old providers fail-closed without
    // rewriting project data. Persisted transition upgrade needs a project
    // migration/write policy so load, undo, and extension activation agree.
    if (schemaVersion === definition.schemaVersion) {
      return isJsonObject(parameters)
        ? {
            parameters: cloneJsonObject(parameters),
            schemaVersion,
          }
        : null;
    }
    if (!definition.migrateParameters || !isJsonObject(parameters)) {
      return null;
    }
    try {
      const migrated = definition.migrateParameters(parameters, schemaVersion);
      if (
        migrated.schemaVersion !== definition.schemaVersion ||
        !isJsonObject(migrated.parameters) ||
        !validateParameters(migrated.parameters, migrated.schemaVersion)
      ) {
        return null;
      }
      return {
        parameters: cloneJsonObject(migrated.parameters),
        schemaVersion: migrated.schemaVersion,
      };
    } catch (error) {
      reportFailureOnce(
        `parameter-migration-${schemaVersion}`,
        `Transition '${contributionId}' threw while migrating parameters.`,
        error,
      );
      return null;
    }
  };

  const renderFrame = (
    context: TransitionRenderContext,
  ): TransitionFrameResult => {
    const schemaVersion =
      context.transition.schemaVersion ?? definition.schemaVersion;
    const migrated = migrateParameters(
      context.transition.parameters,
      schemaVersion,
    );
    if (
      !migrated ||
      !validateParameters(migrated.parameters, migrated.schemaVersion)
    ) {
      reportFailureOnce(
        `invalid-parameters-${context.transition.id}`,
        `Transition '${contributionId}' received invalid parameters.`,
      );
      return {};
    }

    let frame: ExtensionTransitionFrame;
    try {
      frame = definition.renderFrame({
        parameters: Object.freeze(migrated.parameters),
        schemaVersion: migrated.schemaVersion,
        progress: context.progress,
        transition: Object.freeze({
          id: context.transition.id,
          startTicks: context.startTick,
          endTicks: context.endTick,
          durationTicks: context.durationTicks,
        }),
        outgoingClip: toExtensionClipSnapshot(context.outgoingClip),
        incomingClip: toExtensionClipSnapshot(context.incomingClip),
        frame: Object.freeze({
          projectWidth: context.logicalDimensions.width,
          projectHeight: context.logicalDimensions.height,
          fps: context.fps,
          presentationTimeTicks: context.presentationTick,
        }),
      });
    } catch (error) {
      reportFailureOnce(
        `render-${context.transition.id}`,
        `Transition '${contributionId}' renderFrame failed.`,
        error,
      );
      return {};
    }

    try {
      return {
        outgoingTransforms: frame.outgoingTransforms?.map((transform, index) =>
          toClipTransform(context.transition.id, "outgoing", transform, index),
        ),
        incomingTransforms: frame.incomingTransforms?.map((transform, index) =>
          toClipTransform(context.transition.id, "incoming", transform, index),
        ),
        colorLayers: frame.colorLayers?.map((layer, index) =>
          toColorLayer(context.transition.id, layer, index),
        ),
        zOrder: toRuntimeZOrder(frame.zOrder),
      };
    } catch (error) {
      reportFailureOnce(
        `render-output-${context.transition.id}`,
        `Transition '${contributionId}' returned invalid frame output.`,
        error,
      );
      return {};
    }
  };

  return {
    id: definition.id,
    apiVersion: definition.apiVersion,
    execution: "trusted",
    runtimeDefinition: Object.freeze({
      type: contributionId,
      label: definition.label.trim(),
      glyph: definition.glyph,
      parameters: Object.freeze(defaultParameters),
      schemaVersion: definition.schemaVersion,
      uiConfig: Object.freeze({
        groups: Object.freeze(groups),
      }),
      zOrder: toRuntimeZOrder(definition.zOrder),
      renderFrame,
      extension: Object.freeze({
        ownerId,
        contributionId,
        validateParameters,
      }),
    }),
  };
}

export class ExtensionTransitionRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeTransitionContribution>(
      "transition",
    );

  bind(scope: ExtensionApiScope): ExtensionTransitionApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionTransitionDefinition,
      ): ExtensionTransitionRegistration => {
        const registration = bound.register(
          compileDefinition(scope.extension.id, definition, scope.report),
        );
        return Object.freeze({
          id: registration.id,
          dispose: registration.dispose,
        });
      },
    });
  }

  listDefinitions(): readonly TransitionDefinition[] {
    return this.registry
      .list()
      .map((entry) => entry.definition.runtimeDefinition);
  }

  getDefinition(type: string): TransitionDefinition | undefined {
    return this.registry.get(type)?.definition.runtimeDefinition;
  }

  getDefinitionForOwner(
    ownerId: string,
    localId: string,
  ): TransitionDefinition | undefined {
    return this.getDefinition(`${ownerId}/${localId}`);
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }
}

export const extensionTransitionRegistry =
  new ExtensionTransitionRegistry();
