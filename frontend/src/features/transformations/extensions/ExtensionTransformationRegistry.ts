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
  ExtensionHostFilter,
  ExtensionTransformationApi,
  ExtensionTransformationDefinition,
  ExtensionTransformationNumberControl,
  ExtensionTransformationRegistration,
} from "../../extensions/types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionRegistration,
  type ExtensionContributionDefinition,
} from "../../extensions/registry/ExtensionContributionRegistry";
import type { TransformationDefinition } from "../catalogue/types";
import { filterHandler } from "../catalogue/filterHandler";

interface RuntimeTransformationContribution
  extends ExtensionContributionDefinition {
  runtimeDefinition: TransformationDefinition;
}

const HOST_FILTERS: Record<
  ExtensionHostFilter,
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

function assertText(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
}

function validateControl(
  control: ExtensionTransformationNumberControl,
  allowedParameters: ReadonlySet<string>,
): void {
  assertText(control.name, "Transformation control name", 80);
  assertText(
    control.label,
    `Transformation control '${control.name}' label`,
    120,
  );
  if (!allowedParameters.has(control.name)) {
    throw new Error(
      `Host filter does not support parameter '${control.name}'.`,
    );
  }
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
}

function isValidSpline(
  value: unknown,
  control: ExtensionTransformationNumberControl,
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

function compileDefinition(
  ownerId: string,
  definition: ExtensionTransformationDefinition,
  report: ExtensionApiScope["report"],
): RuntimeTransformationContribution {
  if (definition.apiVersion !== 1) {
    throw new Error(
      `Transformation '${definition.id}' must use apiVersion 1.`,
    );
  }
  if (definition.kind !== "host-filter") {
    throw new Error(
      `Transformation '${definition.id}' has an unsupported kind.`,
    );
  }
  assertText(definition.label, `Transformation '${definition.id}' label`, 120);
  if (!Array.isArray(definition.groups) || definition.groups.length === 0) {
    throw new Error(
      `Transformation '${definition.id}' must declare at least one UI group.`,
    );
  }

  const hostFilter = HOST_FILTERS[definition.hostFilter];
  if (!hostFilter) {
    throw new Error(
      `Transformation '${definition.id}' requests an unsupported host filter.`,
    );
  }

  const groupIds = new Set<string>();
  const parameterNames = new Set<string>();
  const controlsByName = new Map<
    string,
    ExtensionTransformationNumberControl
  >();
  const groups = definition.groups.map((group) => {
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

    const controls = group.controls.map(
      (control: ExtensionTransformationNumberControl) => {
        validateControl(control, hostFilter.parameters);
        if (parameterNames.has(control.name)) {
          throw new Error(
            `Duplicate transformation parameter '${control.name}'.`,
          );
        }
        parameterNames.add(control.name);
        const frozenControl = Object.freeze({ ...control });
        controlsByName.set(control.name, frozenControl);
        return frozenControl;
      },
    );
    return Object.freeze({
      id: group.id,
      title: group.title,
      columns: group.columns,
      controls: Object.freeze(controls),
    });
  });

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
  const runtimeDefinition: TransformationDefinition = Object.freeze({
    type: "filter",
    filterName: contributionId,
    FilterClass: hostFilter.FilterClass,
    label: definition.label.trim(),
    compatibleClips: "visual",
    adjustmentCompatible: definition.adjustmentCompatible === true,
    isDefault: false,
    handler: filterHandler,
    uiConfig: Object.freeze({ groups: Object.freeze(groups) }),
    extension: Object.freeze({
      ownerId,
      contributionId,
      validateParameters: (parameters: Readonly<Record<string, unknown>>) => {
        for (const [name, value] of Object.entries(parameters)) {
          const control = controlsByName.get(name);
          if (!control) return false;
          if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= control.min &&
            value <= control.max
          ) {
            continue;
          }
          if (control.supportsSpline === true && isValidSpline(value, control)) {
            continue;
          }
          return false;
        }
        return parameterNames.size === Object.keys(parameters).length;
      },
      reportFailureOnce,
    }),
  });

  return {
    id: definition.id,
    apiVersion: definition.apiVersion,
    runtimeDefinition,
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
        const registration = bound.register(
          compileDefinition(scope.extension.id, definition, scope.report),
        );
        return registration;
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
