import type {
  ExtensionAnimationApi,
  ExtensionAnimationDataMigration,
  ExtensionApiScope,
  ExtensionCompiledInterpolationSegment,
  ExtensionCompiledScalarSource,
  ExtensionCompiledSpatialPath,
  ExtensionInterpolationApi,
  ExtensionInterpolationDefinition,
  ExtensionInterpolationRegistration,
  ExtensionPayload,
  ExtensionPoint2D,
  ExtensionScalarSourceApi,
  ExtensionScalarSourceDefinition,
  ExtensionScalarSourceRegistration,
  ExtensionSpatialPathApi,
  ExtensionSpatialPathDefinition,
  ExtensionSpatialPathRegistration,
  ExtensionResource,
  JsonValue,
} from "../../extensions/types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../../extensions/registry/ExtensionContributionRegistry";
import { jsonValueSchema } from "../../extensions/persistence/extensionPayload";
import { TICKS_PER_SECOND } from "../../../core/time/constants";
import { MonotoneCubicSpline } from "../utils/MonotoneCubicSpline";
import {
  generateArcLengthTable,
  samplePathAtProgress,
} from "../utils/catmullRomUtils";

const CORE_OWNER_ID = "vlo.core";
export const CORE_MONOTONE_INTERPOLATION_ID =
  `${CORE_OWNER_ID}/monotone-cubic` as const;
export const CORE_CATMULL_ROM_PATH_ID =
  `${CORE_OWNER_ID}/centripetal-catmull-rom` as const;

interface AnimationRuntimeMetadata {
  readonly report: ExtensionApiScope["report"];
}

type ScalarSourceContribution = ExtensionContributionDefinition &
  ExtensionScalarSourceDefinition &
  AnimationRuntimeMetadata;
type InterpolationContribution = ExtensionContributionDefinition &
  ExtensionInterpolationDefinition &
  AnimationRuntimeMetadata;
type SpatialPathContribution = ExtensionContributionDefinition &
  ExtensionSpatialPathDefinition &
  AnimationRuntimeMetadata;

export type RegisteredScalarSource =
  RegisteredExtensionContribution<ScalarSourceContribution>;
export type RegisteredInterpolation =
  RegisteredExtensionContribution<InterpolationContribution>;
export type RegisteredSpatialPath =
  RegisteredExtensionContribution<SpatialPathContribution>;

export interface ResolvedAnimationPayload<TDefinition> {
  readonly contribution: TDefinition;
  readonly data: JsonValue;
  readonly schemaVersion: number;
}

function contributionId(payload: ExtensionPayload): string {
  return `${payload.extensionId}/${payload.typeId}`;
}

function assertDefinition(
  definition: {
    readonly id: string;
    readonly apiVersion: number;
    readonly label: string;
    readonly schemaVersion: number;
    readonly defaultData: JsonValue;
    readonly validate: unknown;
    readonly migrate?: unknown;
  },
  kind: string,
): void {
  if (definition.apiVersion !== 1) {
    throw new Error(`${kind} '${definition.id}' must use apiVersion 1.`);
  }
  if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
    throw new Error(`${kind} '${definition.id}' must declare a positive schemaVersion.`);
  }
  if (typeof definition.label !== "string" || definition.label.trim().length === 0) {
    throw new Error(`${kind} '${definition.id}' must declare a label.`);
  }
  if (typeof definition.validate !== "function") {
    throw new TypeError(`${kind} '${definition.id}' must define validate().`);
  }
  if (definition.migrate !== undefined && typeof definition.migrate !== "function") {
    throw new TypeError(`${kind} '${definition.id}' migrate must be a function.`);
  }
  const defaultData = jsonValueSchema.parse(structuredClone(definition.defaultData));
  definition.validate(defaultData, definition.schemaVersion);
}

function cloneAndFreezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => cloneAndFreezeJson(entry)),
    ) as JsonValue;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneAndFreezeJson(entry),
        ]),
      ),
    );
  }
  return value;
}

function prepareDefinition<
  TDefinition extends {
    readonly label: string;
    readonly defaultData: JsonValue;
  },
>(definition: TDefinition): TDefinition {
  return {
    ...definition,
    label: definition.label.trim(),
    defaultData: cloneAndFreezeJson(
      jsonValueSchema.parse(structuredClone(definition.defaultData)),
    ),
  };
}

function resolvePayload<TDefinition extends {
  readonly schemaVersion: number;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionAnimationDataMigration;
}>(
  payload: ExtensionPayload,
  contribution: TDefinition | undefined,
  kind: string,
): ResolvedAnimationPayload<TDefinition> {
  if (!contribution) {
    throw new Error(`${kind} '${contributionId(payload)}' is not registered.`);
  }
  if (payload.schemaVersion > contribution.schemaVersion) {
    throw new Error(
      `${kind} '${contributionId(payload)}' cannot read newer schema ${payload.schemaVersion}.`,
    );
  }

  let schemaVersion = payload.schemaVersion;
  let data = jsonValueSchema.parse(structuredClone(payload.data));
  let migrations = 0;
  while (schemaVersion < contribution.schemaVersion) {
    if (!contribution.migrate) {
      throw new Error(
        `${kind} '${contributionId(payload)}' cannot migrate schema ${schemaVersion}.`,
      );
    }
    const migrated = contribution.migrate(structuredClone(data), schemaVersion);
    if (
      !Number.isInteger(migrated.schemaVersion) ||
      migrated.schemaVersion <= schemaVersion ||
      migrated.schemaVersion > contribution.schemaVersion
    ) {
      throw new Error(
        `${kind} '${contributionId(payload)}' returned invalid migration schema ${migrated.schemaVersion}.`,
      );
    }
    data = jsonValueSchema.parse(migrated.data);
    schemaVersion = migrated.schemaVersion;
    migrations += 1;
    if (migrations > 100) {
      throw new Error(`${kind} '${contributionId(payload)}' exceeded 100 migrations.`);
    }
  }
  contribution.validate(structuredClone(data), schemaVersion);
  return { contribution, data, schemaVersion };
}

function assertCompiledResource(
  value: unknown,
  method: "sample" | "pointAt",
  label: string,
): asserts value is { dispose(): void; [key: string]: unknown } {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { dispose?: unknown }).dispose !== "function" ||
    typeof (value as Record<string, unknown>)[method] !== "function"
  ) {
    throw new TypeError(`${label} compile() returned an invalid runtime object.`);
  }
}

function createHostScope(): ExtensionApiScope {
  const signal = new AbortController().signal;
  return Object.freeze({
    extension: Object.freeze({ id: CORE_OWNER_ID, version: "1.0.0" }),
    signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  });
}

export class ExtensionScalarSourceRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<ScalarSourceContribution>("scalar-source");

  bind(scope: ExtensionApiScope): ExtensionScalarSourceApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionScalarSourceDefinition,
      ): ExtensionScalarSourceRegistration => {
        assertDefinition(definition, "Scalar source");
        if (typeof definition.compile !== "function") {
          throw new TypeError(`Scalar source '${definition.id}' must define compile().`);
        }
        if (definition.remap !== undefined && typeof definition.remap !== "function") {
          throw new TypeError(`Scalar source '${definition.id}' remap must be a function.`);
        }
        if (definition.editor !== undefined && typeof definition.editor !== "function") {
          throw new TypeError(`Scalar source '${definition.id}' editor must be a function.`);
        }
        const registration = bound.register(
          prepareDefinition({ ...definition, report: scope.report }),
        );
        return Object.freeze({
          id: registration.id,
          dispose: () => registration.dispose(),
        });
      },
    });
  }

  get(payload: ExtensionPayload): RegisteredScalarSource | undefined {
    return this.registry.get(contributionId(payload));
  }

  resolve(payload: ExtensionPayload): ResolvedAnimationPayload<ScalarSourceContribution> {
    return resolvePayload(payload, this.get(payload)?.definition, "Scalar source");
  }

  compile(payload: ExtensionPayload): ExtensionCompiledScalarSource {
    const resolved = this.resolve(payload);
    const compiled = resolved.contribution.compile(
      structuredClone(resolved.data),
      resolved.schemaVersion,
      { ticksPerSecond: TICKS_PER_SECOND },
    );
    assertCompiledResource(compiled, "sample", `Scalar source '${contributionId(payload)}'`);
    return compiled;
  }

  getRevision(): number {
    return this.registry.getRevision();
  }

  list(): readonly RegisteredScalarSource[] {
    return this.registry.list();
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }
}

export class ExtensionInterpolationRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<InterpolationContribution>("interpolation");

  constructor() {
    const core = this.registry.bind(createHostScope());
    core.register({
      id: "monotone-cubic",
      apiVersion: 1,
      label: "Monotone cubic",
      schemaVersion: 1,
      defaultData: null,
      report: () => undefined,
      validate: (data) => {
        if (data !== null) throw new Error("Core monotone interpolation data must be null.");
      },
      compile: ({ keyframes }) => {
        const spline = new MonotoneCubicSpline(
          keyframes.map(({ time, value }) => ({ time, value })),
        );
        return Object.freeze({
          sample: (time: number) => spline.at(time),
          dispose: () => undefined,
        });
      },
    });
  }

  bind(scope: ExtensionApiScope): ExtensionInterpolationApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionInterpolationDefinition,
      ): ExtensionInterpolationRegistration => {
        assertDefinition(definition, "Interpolation");
        if (typeof definition.compile !== "function") {
          throw new TypeError(`Interpolation '${definition.id}' must define compile().`);
        }
        if (definition.remap !== undefined && typeof definition.remap !== "function") {
          throw new TypeError(`Interpolation '${definition.id}' remap must be a function.`);
        }
        if (definition.editor !== undefined && typeof definition.editor !== "function") {
          throw new TypeError(`Interpolation '${definition.id}' editor must be a function.`);
        }
        const registration = bound.register(
          prepareDefinition({ ...definition, report: scope.report }),
        );
        return Object.freeze({
          id: registration.id,
          dispose: () => registration.dispose(),
        });
      },
    });
  }

  get(payload: ExtensionPayload): RegisteredInterpolation | undefined {
    return this.registry.get(contributionId(payload));
  }

  resolve(payload: ExtensionPayload): ResolvedAnimationPayload<InterpolationContribution> {
    return resolvePayload(payload, this.get(payload)?.definition, "Interpolation");
  }

  compile(
    payload: ExtensionPayload,
    keyframes: readonly { time: number; value: number; outgoing?: ExtensionPayload }[],
    segmentIndex: number,
  ): ExtensionCompiledInterpolationSegment {
    const resolved = this.resolve(payload);
    const input = {
      keyframes: structuredClone(keyframes),
      segmentIndex,
      data: structuredClone(resolved.data),
      schemaVersion: resolved.schemaVersion,
    };
    const compiled = resolved.contribution.compile(input);
    assertCompiledResource(
      compiled,
      "sample",
      `Interpolation '${contributionId(payload)}'`,
    );
    return compiled;
  }

  getRevision(): number {
    return this.registry.getRevision();
  }

  list(): readonly RegisteredInterpolation[] {
    return this.registry.list();
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }
}

function parseCorePoints(data: JsonValue): ExtensionPoint2D[] {
  if (!Array.isArray(data)) throw new Error("Core path data must be an array.");
  return data.map((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.x !== "number" ||
      !Number.isFinite(value.x) ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.y)
    ) {
      throw new Error("Core path points must contain finite x/y coordinates.");
    }
    return { x: value.x, y: value.y };
  });
}

export class ExtensionSpatialPathRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<SpatialPathContribution>("spatial-path");

  constructor() {
    const core = this.registry.bind(createHostScope());
    core.register({
      id: "centripetal-catmull-rom",
      apiVersion: 1,
      label: "Centripetal Catmull–Rom",
      schemaVersion: 1,
      defaultData: [],
      report: () => undefined,
      validate: (data) => {
        parseCorePoints(data);
      },
      compile: (data) => {
        const points = parseCorePoints(data);
        const table = generateArcLengthTable(points, 24, 0.5);
        return Object.freeze({
          pointAt: (progress: number) =>
            samplePathAtProgress(points, table, progress, 0.5),
          dispose: () => undefined,
        });
      },
      reverse: (data) => ({
        schemaVersion: 1,
        data: [...parseCorePoints(data)]
          .reverse()
          .map(({ x, y }) => ({ x, y })),
      }),
    });
  }

  bind(scope: ExtensionApiScope): ExtensionSpatialPathApi {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionSpatialPathDefinition,
      ): ExtensionSpatialPathRegistration => {
        assertDefinition(definition, "Spatial path");
        if (typeof definition.compile !== "function") {
          throw new TypeError(`Spatial path '${definition.id}' must define compile().`);
        }
        if (definition.reverse !== undefined && typeof definition.reverse !== "function") {
          throw new TypeError(`Spatial path '${definition.id}' reverse must be a function.`);
        }
        if (definition.editor !== undefined && typeof definition.editor !== "function") {
          throw new TypeError(`Spatial path '${definition.id}' editor must be a function.`);
        }
        if (
          definition.createOverlay !== undefined &&
          typeof definition.createOverlay !== "function"
        ) {
          throw new TypeError(`Spatial path '${definition.id}' createOverlay must be a function.`);
        }
        const registration = bound.register(
          prepareDefinition({ ...definition, report: scope.report }),
        );
        return Object.freeze({
          id: registration.id,
          dispose: () => registration.dispose(),
        });
      },
    });
  }

  get(payload: ExtensionPayload): RegisteredSpatialPath | undefined {
    return this.registry.get(contributionId(payload));
  }

  resolve(payload: ExtensionPayload): ResolvedAnimationPayload<SpatialPathContribution> {
    return resolvePayload(payload, this.get(payload)?.definition, "Spatial path");
  }

  compile(payload: ExtensionPayload): ExtensionCompiledSpatialPath {
    const resolved = this.resolve(payload);
    const compiled = resolved.contribution.compile(
      structuredClone(resolved.data),
      resolved.schemaVersion,
    );
    assertCompiledResource(
      compiled,
      "pointAt",
      `Spatial path '${contributionId(payload)}'`,
    );
    return compiled;
  }

  getRevision(): number {
    return this.registry.getRevision();
  }

  list(): readonly RegisteredSpatialPath[] {
    return this.registry.list();
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }
}

export const extensionScalarSourceRegistry = new ExtensionScalarSourceRegistry();
export const extensionInterpolationRegistry = new ExtensionInterpolationRegistry();
export const extensionSpatialPathRegistry = new ExtensionSpatialPathRegistry();

export function createExtensionAnimationApi(
  scope: ExtensionApiScope,
): ExtensionAnimationApi {
  return Object.freeze({
    scalarSources: extensionScalarSourceRegistry.bind(scope),
    interpolations: extensionInterpolationRegistry.bind(scope),
    spatialPaths: extensionSpatialPathRegistry.bind(scope),
  });
}
