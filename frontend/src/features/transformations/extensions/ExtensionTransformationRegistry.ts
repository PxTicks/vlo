import {
  AdjustmentFilter,
  AsciiFilter,
  BloomFilter,
  BulgePinchFilter,
  CRTFilter,
  DotFilter,
  GlowFilter,
  HslAdjustmentFilter,
  OldFilmFilter,
} from "pixi-filters";
import type { Filter } from "pixi.js";
import type {
  ExtensionApiScope,
  ExtensionDeclarativeHostFilter,
  ExtensionTransformationApi,
  ExtensionTransformationControl,
  ExtensionTransformationDefinition,
  ExtensionTransformationRegistration,
  ExtensionTransformationSelectOption,
  JsonValue,
} from "../../extensions/types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionRegistration,
  type ExtensionContributionDefinition,
} from "../../extensions/registry/ExtensionContributionRegistry";
import type {
  TransformationDefinition,
  TransformContext,
  TransformState,
} from "../catalogue/types";
import type { ClipTransform } from "../../../types/TimelineTypes";
import {
  filterHandler,
  resolveTransformationParameters,
} from "../catalogue/filterHandler";
import { createTrustedExtensionFilterFactory } from "./TrustedExtensionFilterRuntime";

interface RuntimeTransformationContribution
  extends ExtensionContributionDefinition {
  runtimeDefinition: TransformationDefinition;
  disposeRuntime?: () => void;
}

const DECLARATIVE_HOST_FILTERS: Record<
  ExtensionDeclarativeHostFilter,
  {
    FilterClass: new () => Filter;
    parameters: ReadonlySet<string>;
  }
> = {
  "color-adjustment": {
    FilterClass: AdjustmentFilter,
    parameters: new Set([
      "red",
      "green",
      "blue",
      "alpha",
      "gamma",
      "contrast",
      "saturation",
      "brightness",
    ]),
  },
  "hsl-adjustment": {
    FilterClass: HslAdjustmentFilter,
    parameters: new Set(["hue", "saturation", "lightness", "alpha"]),
  },
  // Only resolution-independent numeric scalar properties are exposed. Spatial
  // filters whose host definitions rely on parameter scaling or point bindings
  // (blur, twist, shockwave, zoom-blur, godray, pixelate, reflection) are
  // omitted because the declarative path does not wire that machinery, and
  // non-numeric properties (colors, points, booleans) are excluded by name.
  bloom: {
    FilterClass: BloomFilter,
    parameters: new Set(["strength", "quality"]),
  },
  glow: {
    FilterClass: GlowFilter,
    parameters: new Set(["distance", "outerStrength", "innerStrength"]),
  },
  crt: {
    FilterClass: CRTFilter,
    parameters: new Set([
      "curvature",
      "lineWidth",
      "lineContrast",
      "noise",
      "noiseSize",
      "vignetting",
      "vignettingAlpha",
      "vignettingBlur",
      "seed",
    ]),
  },
  "old-film": {
    FilterClass: OldFilmFilter,
    parameters: new Set([
      "sepia",
      "noise",
      "noiseSize",
      "scratch",
      "scratchDensity",
      "scratchWidth",
      "vignetting",
      "vignettingAlpha",
      "vignettingBlur",
      "seed",
    ]),
  },
  dot: {
    FilterClass: DotFilter,
    parameters: new Set(["scale", "angle"]),
  },
  ascii: {
    FilterClass: AsciiFilter,
    parameters: new Set(["size"]),
  },
  "bulge-pinch": {
    FilterClass: BulgePinchFilter,
    parameters: new Set(["strength", "radius"]),
  },
};

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

const LOCAL_COMPONENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

function validateControl(
  control: ExtensionTransformationControl,
  allowedParameters?: ReadonlySet<string>,
): void {
  assertText(control.name, "Transformation control name", 80);
  assertText(
    control.label,
    `Transformation control '${control.name}' label`,
    120,
  );
  if (allowedParameters && control.type === "custom") {
    throw new Error(
      `Host filter '${control.name}' cannot use a custom control.`,
    );
  }
  if (allowedParameters && !allowedParameters.has(control.name)) {
    throw new Error(
      `Host filter does not support parameter '${control.name}'.`,
    );
  }
  if (allowedParameters && control.type !== "slider" && control.type !== "number") {
    throw new Error(
      `Host filter parameter '${control.name}' must use a numeric control.`,
    );
  }

  if (control.type === "custom") {
    // A local ID only. Qualification is the host's job, so one extension cannot
    // mount another extension's component by naming its qualified ID here.
    if (
      typeof control.componentId !== "string" ||
      !LOCAL_COMPONENT_ID_PATTERN.test(control.componentId)
    ) {
      throw new Error(
        `Transformation control '${control.name}' must name a panel control registered by this extension.`,
      );
    }
    if (control.config !== undefined && !isJsonValue(control.config)) {
      throw new Error(
        `Transformation control '${control.name}' config must be JSON.`,
      );
    }
    if (
      control.parameterNames !== undefined &&
      (!Array.isArray(control.parameterNames) ||
        control.parameterNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error(
        `Transformation control '${control.name}' parameterNames must be strings.`,
      );
    }
    return;
  }

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
        `Transformation control '${control.name}' has invalid numeric bounds.`,
      );
    }
    if (
      control.step !== undefined &&
      (!Number.isFinite(control.step) || control.step <= 0)
    ) {
      throw new Error(
        `Transformation control '${control.name}' step must be positive.`,
      );
    }
    return;
  }

  if (control.type === "text") {
    if (control.defaultValue.length > 10_000) {
      throw new Error(
        `Transformation control '${control.name}' default text is too long.`,
      );
    }
    return;
  }

  if (control.type === "color") {
    if (!COLOR_PATTERN.test(control.defaultValue)) {
      throw new Error(
        `Transformation control '${control.name}' must use a #RRGGBB color.`,
      );
    }
    return;
  }

  if (control.type === "select") {
    if (!Array.isArray(control.options) || control.options.length === 0) {
      throw new Error(
        `Transformation control '${control.name}' must declare select options.`,
      );
    }
    for (const option of control.options) {
      assertText(
        option.label,
        `Transformation control '${control.name}' option label`,
        120,
      );
      if (!isJsonValue(option.value)) {
        throw new Error(
          `Transformation control '${control.name}' option values must be JSON.`,
        );
      }
    }
    if (
      !isJsonValue(control.defaultValue) ||
      !control.options.some((option) =>
        jsonValuesEqual(option.value, control.defaultValue),
      )
    ) {
      throw new Error(
        `Transformation control '${control.name}' default must match an option.`,
      );
    }
  }
}

function isValidSpline(
  value: unknown,
  control: Extract<
    ExtensionTransformationControl,
    { type: "slider" | "number" }
  >,
): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "spline" ||
    !("points" in value) ||
    !Array.isArray(value.points)
  ) {
    return false;
  }
  return value.points.every(
    (point) =>
      typeof point === "object" &&
      point !== null &&
      "time" in point &&
      "value" in point &&
      typeof point.time === "number" &&
      Number.isFinite(point.time) &&
      typeof point.value === "number" &&
      Number.isFinite(point.value) &&
      point.value >= control.min &&
      point.value <= control.max,
  );
}

function isValidControlValue(
  value: unknown,
  control: ExtensionTransformationControl,
): boolean {
  if (control.type === "slider" || control.type === "number") {
    return (
      (typeof value === "number" &&
        Number.isFinite(value) &&
        value >= control.min &&
        value <= control.max) ||
      (control.supportsSpline === true && isValidSpline(value, control))
    );
  }
  if (control.type === "checkbox") return typeof value === "boolean";
  if (control.type === "text") {
    return typeof value === "string";
  }
  if (control.type === "color") {
    return typeof value === "string" && COLOR_PATTERN.test(value);
  }
  if (control.type === "select") {
    return (
      isJsonValue(value) &&
      control.options.some((option) => jsonValuesEqual(option.value, value))
    );
  }
  return false;
}

type ExtensionTransformationParameterControl = Exclude<
  ExtensionTransformationControl,
  { type: "custom" }
>;

function compileDefinition(
  ownerId: string,
  definition: ExtensionTransformationDefinition,
  report: ExtensionApiScope["report"],
): RuntimeTransformationContribution {
  const definitionId = definition.id;
  if (definition.apiVersion !== 1) {
    throw new Error(
      `Transformation '${definition.id}' must use apiVersion 1.`,
    );
  }
  if (
    definition.kind !== "host-filter" &&
    definition.kind !== "trusted-filter" &&
    definition.kind !== "trusted-transformation"
  ) {
    throw new Error(
      `Transformation '${definitionId}' has an unsupported kind.`,
    );
  }
  assertText(definition.label, `Transformation '${definition.id}' label`, 120);
  if (!Array.isArray(definition.groups) || definition.groups.length === 0) {
    throw new Error(
      `Transformation '${definition.id}' must declare at least one UI group.`,
    );
  }

  const hostFilter =
    definition.kind === "host-filter"
      ? DECLARATIVE_HOST_FILTERS[definition.hostFilter]
      : undefined;
  if (definition.kind === "host-filter" && !hostFilter) {
    throw new Error(
      `Transformation '${definition.id}' requests an unsupported host filter.`,
    );
  }
  if (
    definition.kind === "trusted-filter" &&
    typeof definition.createFilter !== "function"
  ) {
    throw new Error(
      `Trusted transformation '${definition.id}' must provide createFilter.`,
    );
  }
  if (
    definition.kind === "trusted-transformation" &&
    typeof definition.apply !== "function"
  ) {
    throw new Error(
      `Trusted transformation '${definition.id}' must provide apply.`,
    );
  }

  const groupIds = new Set<string>();
  const controlNames = new Set<string>();
  const parameterNames = new Set<string>();
  const controlsByName = new Map<
    string,
    ExtensionTransformationParameterControl
  >();

  // First pass validates and collects the persisted parameter set. Custom
  // controls are UI-only: they never become parameters, so they are excluded
  // from `controlsByName` and from `defaultParameters`.
  for (const group of definition.groups) {
    assertText(group.id, "Transformation UI group ID", 80);
    assertText(group.title, `Transformation UI group '${group.id}' title`, 120);
    if (groupIds.has(group.id)) {
      throw new Error(`Duplicate transformation UI group '${group.id}'.`);
    }
    groupIds.add(group.id);
    if (!Array.isArray(group.controls) || group.controls.length === 0) {
      throw new Error(
        `Transformation UI group '${group.id}' must contain controls.`,
      );
    }
    if (
      group.columns !== undefined &&
      (!Number.isInteger(group.columns) ||
        group.columns < 1 ||
        group.columns > 4)
    ) {
      throw new Error(
        `Transformation UI group '${group.id}' columns must be an integer from 1 to 4.`,
      );
    }
    for (const control of group.controls) {
      validateControl(control, hostFilter?.parameters);
      if (controlNames.has(control.name)) {
        throw new Error(
          `Duplicate transformation control '${control.name}'.`,
        );
      }
      controlNames.add(control.name);
      if (control.type === "custom") continue;
      parameterNames.add(control.name);
      const frozenControl: ExtensionTransformationParameterControl =
        control.type === "select"
          ? Object.freeze({
              ...control,
              defaultValue: cloneAndFreezeJsonValue(control.defaultValue),
              options: Object.freeze(
                control.options.map(
                  (option: ExtensionTransformationSelectOption) =>
                    Object.freeze({
                      label: option.label,
                      value: cloneAndFreezeJsonValue(option.value),
                    }),
                ),
              ),
            })
          : Object.freeze({ ...control });
      controlsByName.set(control.name, frozenControl);
    }
  }

  // Second pass emits the panel layout. A custom control's commit allowlist can
  // only be resolved once every parameter in the definition is known, since a
  // rich editor may appear before the parameters it edits.
  const groups = definition.groups.map((group) =>
    Object.freeze({
      id: group.id,
      title: group.title,
      columns: group.columns,
      controls: Object.freeze(
        group.controls.map((control: ExtensionTransformationControl) => {
          if (control.type !== "custom") {
            return controlsByName.get(control.name)!;
          }
          const allowed = control.parameterNames ?? [...parameterNames];
          for (const name of allowed) {
            if (!parameterNames.has(name)) {
              throw new Error(
                `Transformation control '${control.name}' cannot commit unknown parameter '${name}'.`,
              );
            }
          }
          return Object.freeze({
            type: "custom" as const,
            name: control.name,
            label: control.label,
            componentId: `${ownerId}/${control.componentId}`,
            ...(control.config
              ? { config: cloneAndFreezeJsonValue(control.config) }
              : {}),
            parameterNames: Object.freeze([...allowed]),
          });
        }),
      ),
    }),
  );

  const contributionId = `${ownerId}/${definition.id}`;
  const reportedFailureKeys = new Set<string>();
  const reportFailureOnce: NonNullable<
    TransformationDefinition["extension"]
  >["reportFailureOnce"] = (key, level, message, detail) => {
    if (reportedFailureKeys.has(key) || reportedFailureKeys.size >= 500) {
      return;
    }
    reportedFailureKeys.add(key);
    report(level, message, detail);
  };

  const customValidate =
    definition.kind === "trusted-filter" ||
    definition.kind === "trusted-transformation"
      ? definition.validateParameters
      : undefined;
  const validateParameters = (
    parameters: Readonly<Record<string, unknown>>,
  ): boolean => {
    for (const [name, control] of controlsByName) {
      if (
        !Object.hasOwn(parameters, name) ||
        !isValidControlValue(parameters[name], control)
      ) {
        return false;
      }
    }
    if (!customValidate) {
      return parameterNames.size === Object.keys(parameters).length;
    }
    try {
      return customValidate(parameters) === true;
    } catch (error) {
      reportFailureOnce(
        "parameter-validator",
        "error",
        `Trusted transformation '${contributionId}' threw while validating parameters.`,
        error,
      );
      return false;
    }
  };

  const defaultParameters: Record<string, JsonValue> = {};
  for (const [name, control] of controlsByName) {
    if (!isJsonValue(control.defaultValue)) {
      throw new Error(
        `Transformation control '${name}' default value must be JSON.`,
      );
    }
    defaultParameters[name] = cloneAndFreezeJsonValue(control.defaultValue);
  }
  if (
    (definition.kind === "trusted-filter" ||
      definition.kind === "trusted-transformation") &&
    definition.defaultParameters
  ) {
    for (const [name, value] of Object.entries(definition.defaultParameters)) {
      if (!isJsonValue(value)) {
        throw new Error(
          `Trusted transformation '${definition.id}' default '${name}' must be JSON.`,
        );
      }
      defaultParameters[name] = cloneAndFreezeJsonValue(value);
    }
  }
  if (!validateParameters(defaultParameters)) {
    throw new Error(
      `Transformation '${definition.id}' has invalid default parameters.`,
    );
  }

  const filterFactory =
    definition.kind === "trusted-filter"
      ? createTrustedExtensionFilterFactory(
          contributionId,
          definition,
          reportFailureOnce,
        )
      : undefined;
  const runtimeDefinition: TransformationDefinition = Object.freeze({
    type:
      definition.kind === "trusted-transformation"
        ? contributionId
        : "filter",
    filterName:
      definition.kind === "trusted-transformation"
        ? undefined
        : contributionId,
    FilterClass: hostFilter?.FilterClass,
    filterFactory,
    label: definition.label.trim(),
    compatibleClips: "visual",
    adjustmentCompatible: definition.adjustmentCompatible === true,
    isDefault: false,
    handler:
      definition.kind === "trusted-transformation"
        ? (
            state: TransformState,
            transform: ClipTransform,
            context: TransformContext,
          ) =>
            definition.apply({
              state,
              transform: {
                ...transform,
                parameters: resolveTransformationParameters(
                  transform.parameters,
                  context.time ?? 0,
                ),
              },
              render: context,
            })
        : filterHandler,
    uiConfig: Object.freeze({ groups: Object.freeze(groups) }),
    defaultParameters: Object.freeze(defaultParameters),
    extension: Object.freeze({
      ownerId,
      contributionId,
      validateParameters,
      reportFailureOnce,
    }),
  });

  return {
    id: definition.id,
    apiVersion: definition.apiVersion,
    execution:
      definition.kind === "host-filter" ? "restricted" : "trusted",
    runtimeDefinition,
    disposeRuntime: filterFactory?.dispose,
  };
}

export class ExtensionTransformationRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeTransformationContribution>(
      "transformation",
    );

  bind(scope: ExtensionApiScope): ExtensionTransformationApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionTransformationDefinition,
      ): ExtensionTransformationRegistration => {
        const compiled = compileDefinition(
          scope.extension.id,
          definition,
          scope.report,
        );
        const registration = bound.register(compiled);
        if (!compiled.disposeRuntime) return registration;

        let disposed = false;
        const managedRegistration: ExtensionTransformationRegistration =
          Object.freeze({
            id: registration.id,
            dispose: () => {
              if (disposed) return;
              disposed = true;
              compiled.disposeRuntime?.();
              registration.dispose();
            },
          });
        scope.own(managedRegistration);
        return managedRegistration;
      },
    });
  }

  /** Internal seam for bundled definitions and low-level renderer tests. */
  registerRuntime(
    scope: ExtensionApiScope,
    localId: string,
    runtimeDefinition: TransformationDefinition,
  ): ExtensionContributionRegistration<RuntimeTransformationContribution> {
    return this.registry.bind(scope).register({
      id: localId,
      apiVersion: 1,
      runtimeDefinition,
    });
  }

  listDefinitions(): readonly TransformationDefinition[] {
    return this.registry
      .list()
      .map((entry) => entry.definition.runtimeDefinition);
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }
}

export const extensionTransformationRegistry =
  new ExtensionTransformationRegistry();
