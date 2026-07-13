import {
  COLOR_HISTOGRAM_BIN_COUNT,
  DEFAULT_COLOR_GRADE_PARAMETERS,
  applyMatrix3,
  applyReferenceColorGradePixel,
  assertStaticColorGradeValues,
  bakeColorCurveLut,
  bakeColorGradeCube,
  buildColorHistograms,
  createColorCurveSampler,
  createIdentityCubeLut,
  createReferenceColorGradeEvaluator,
  getColorGradeParameterKind,
  isColorGradeParameterName,
  isSupportedColorGradeModel,
  linearToSrgb,
  normalizeColorGradeParameterPatch,
  normalizeColorGradeParameters,
  parseCubeLut,
  sampleCubeLut,
  serializeCubeLut,
  srgbToLinear,
  whiteBalanceMatrix,
  V1_AUTHORED_COLOR_MODEL,
} from "../../../core/color";
import { COLOR_GRADE_FILTER_NAME } from "../../transformations/catalogue/filters/colorGrade/definition";
import { resolveTransformationParameters } from "../../transformations/extensionApi";
import {
  extensionPayloadSchema,
  jsonValueSchema,
} from "../persistence/extensionPayload";
import type {
  ColorGradeAuthoredParametersV1,
  ColorGradeParameterPatchV1,
  ColorGradeResolvedParametersV1,
  ColorGradeStaticInputV1,
  ExtensionColorApi,
  ExtensionColorGradeApi,
  ExtensionTimelineTransformInput,
  ExtensionTimelineTransformSnapshot,
  JsonValue,
} from "../types";

export class ExtensionColorGradeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExtensionColorGradeError";
  }
}

function isColorGradeTransform(
  transform: ExtensionTimelineTransformSnapshot,
): boolean {
  return (
    transform.type === "filter" &&
    transform.filterName === COLOR_GRADE_FILTER_NAME
  );
}

function fail(message: string): never {
  throw new ExtensionColorGradeError(message);
}

function parseJsonObject(
  value: unknown,
  label: string,
): Record<string, JsonValue> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const undefinedField = Object.keys(value).find(
      (key) => (value as Record<string, unknown>)[key] === undefined,
    );
    if (undefinedField) {
      fail(`Field '${undefinedField}' in ${label} must not be undefined.`);
    }
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    fail(`${label} must be a finite JSON object.`);
  }
  return parsed.data as Record<string, JsonValue>;
}

function assertExactKeys(
  value: Readonly<Record<string, JsonValue>>,
  expected: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !expected.has(key));
  if (unexpected) fail(`${label} contains unknown field '${unexpected}'.`);
}

function assertLegacySpline(value: Record<string, JsonValue>, name: string): void {
  assertExactKeys(value, new Set(["type", "points"]), `Grade parameter '${name}'`);
  if (!Array.isArray(value.points) || value.points.length === 0) {
    fail(`Grade parameter '${name}' must contain at least one spline point.`);
  }
  let previousTime = Number.NEGATIVE_INFINITY;
  value.points.forEach((point, index) => {
    const parsedPoint = parseJsonObject(point, `Spline point ${index}`);
    assertExactKeys(
      parsedPoint,
      new Set(["time", "value"]),
      `Spline point ${index}`,
    );
    if (
      typeof parsedPoint.time !== "number" ||
      !Number.isFinite(parsedPoint.time) ||
      typeof parsedPoint.value !== "number" ||
      !Number.isFinite(parsedPoint.value)
    ) {
      fail(`Spline point ${index} must contain finite time and value numbers.`);
    }
    if (parsedPoint.time <= previousTime) {
      fail(`Grade parameter '${name}' spline points must be strictly time-ordered.`);
    }
    previousTime = parsedPoint.time;
  });
}

function assertExtensionPayload(value: JsonValue | undefined, label: string): void {
  if (!extensionPayloadSchema.safeParse(value).success) {
    fail(`${label} must contain a valid extension payload.`);
  }
}

function assertExtensionScalar(
  value: Record<string, JsonValue>,
  name: string,
): void {
  assertExactKeys(value, new Set(["type", "source"]), `Grade parameter '${name}'`);
  assertExtensionPayload(value.source, `Grade parameter '${name}'`);
}

function assertExtensionKeyframedScalar(
  value: Record<string, JsonValue>,
  name: string,
): void {
  assertExactKeys(
    value,
    new Set(["type", "keyframes"]),
    `Grade parameter '${name}'`,
  );
  if (!Array.isArray(value.keyframes) || value.keyframes.length === 0) {
    fail(`Grade parameter '${name}' must contain at least one keyframe.`);
  }
  const keyframes = value.keyframes;
  let previousTime = Number.NEGATIVE_INFINITY;
  keyframes.forEach((keyframe, index) => {
    const parsedKeyframe = parseJsonObject(keyframe, `Keyframe ${index}`);
    assertExactKeys(
      parsedKeyframe,
      new Set(["time", "value", "outgoing"]),
      `Keyframe ${index}`,
    );
    if (
      typeof parsedKeyframe.time !== "number" ||
      !Number.isFinite(parsedKeyframe.time) ||
      typeof parsedKeyframe.value !== "number" ||
      !Number.isFinite(parsedKeyframe.value)
    ) {
      fail(`Keyframe ${index} must contain finite time and value numbers.`);
    }
    if (parsedKeyframe.time <= previousTime) {
      fail(`Grade parameter '${name}' keyframes must be strictly time-ordered.`);
    }
    const isFinal = index === keyframes.length - 1;
    if (!isFinal && parsedKeyframe.outgoing === undefined) {
      fail(`Grade parameter '${name}' keyframe ${index} has no interpolation provider.`);
    }
    if (parsedKeyframe.outgoing !== undefined) {
      assertExtensionPayload(
        parsedKeyframe.outgoing,
        `Grade parameter '${name}' keyframe ${index}`,
      );
    }
    previousTime = parsedKeyframe.time;
  });
}

function assertAuthoredScalar(value: JsonValue, name: string): void {
  if (typeof value === "number" && Number.isFinite(value)) return;
  const objectValue = parseJsonObject(value, `Grade parameter '${name}'`);
  if (objectValue.type === "spline") {
    assertLegacySpline(objectValue, name);
    return;
  }
  if (objectValue.type === "extension-scalar") {
    assertExtensionScalar(objectValue, name);
    return;
  }
  if (objectValue.type === "extension-keyframed-scalar") {
    assertExtensionKeyframedScalar(objectValue, name);
    return;
  }
  fail(`Grade parameter '${name}' contains an unsupported animation value.`);
}

function assertAuthoredGradeValues(
  source: Readonly<Record<string, JsonValue>>,
): void {
  if (!isSupportedColorGradeModel(source.colorModel)) {
    fail("Grade uses an unsupported color model. This SDK understands V1 grades only.");
  }
  for (const [name, value] of Object.entries(source)) {
    if (name === "colorModel") continue;
    if (!isColorGradeParameterName(name)) {
      fail(`Unknown grade parameter '${name}'.`);
    }
    if (getColorGradeParameterKind(name) === "number") {
      assertAuthoredScalar(value, name);
      continue;
    }
    try {
      assertStaticColorGradeValues({ [name]: value }, { allowColorModel: false });
    } catch (error) {
      fail(error instanceof Error ? error.message : `Invalid grade parameter '${name}'.`);
    }
  }
}

function parseTransform(
  transform: ExtensionTimelineTransformSnapshot,
): ColorGradeAuthoredParametersV1 | null {
  if (
    typeof transform !== "object" ||
    transform === null ||
    !isColorGradeTransform(transform)
  ) {
    return null;
  }
  const parameters = parseJsonObject(transform.parameters ?? {}, "Grade parameters");
  assertAuthoredGradeValues(parameters);
  return structuredClone({
    ...parameters,
    colorModel: V1_AUTHORED_COLOR_MODEL,
  }) as ColorGradeAuthoredParametersV1;
}

function normalizeGrade(
  partial: ColorGradeStaticInputV1,
): ColorGradeResolvedParametersV1 {
  const parameters = parseJsonObject(partial, "Grade parameters");
  try {
    assertStaticColorGradeValues(parameters);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid grade parameters.");
  }
  return normalizeColorGradeParameters(parameters);
}

function normalizeGradePatch(
  patch: ColorGradeParameterPatchV1,
): Partial<ColorGradeResolvedParametersV1> {
  const parameters = parseJsonObject(patch, "Grade parameter patch");
  try {
    assertStaticColorGradeValues(parameters, { allowColorModel: false });
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid grade parameter patch.");
  }
  return normalizeColorGradeParameterPatch(parameters);
}

function resolveGrade(
  authored: ColorGradeAuthoredParametersV1,
  options: { readonly sourceTime: number },
): ColorGradeResolvedParametersV1 {
  const sourceTime = options?.sourceTime;
  if (typeof sourceTime !== "number" || !Number.isFinite(sourceTime)) {
    fail("resolve() requires a finite sourceTime.");
  }
  const parameters = parseJsonObject(authored, "Authored grade");
  assertAuthoredGradeValues(parameters);
  const resolved = resolveTransformationParameters(parameters, sourceTime);
  try {
    assertStaticColorGradeValues(resolved);
  } catch (error) {
    fail(error instanceof Error ? error.message : "The grade could not be resolved.");
  }
  return normalizeColorGradeParameters(resolved);
}

function normalizeTransformId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("Transform ID must be a non-empty string.");
  }
  const normalized = value.trim();
  if (normalized.length > 200) fail("Transform ID must be at most 200 characters.");
  return normalized;
}

function toTransformInput(
  source: ColorGradeAuthoredParametersV1 | ColorGradeResolvedParametersV1,
  options?: { readonly transformId?: string; readonly isEnabled?: boolean },
): ExtensionTimelineTransformInput {
  const parameters = parseJsonObject(source, "Grade parameters");
  assertAuthoredGradeValues(parameters);
  const transformId = normalizeTransformId(options?.transformId);
  if (options?.isEnabled !== undefined && typeof options.isEnabled !== "boolean") {
    fail("isEnabled must be a boolean.");
  }
  const persistedParameters: Record<string, JsonValue> = structuredClone(parameters);
  persistedParameters.colorModel = {
    version: V1_AUTHORED_COLOR_MODEL.version,
    gradingSpace: V1_AUTHORED_COLOR_MODEL.gradingSpace,
  };
  return Object.freeze({
    ...(transformId ? { id: transformId } : {}),
    type: "filter",
    filterName: COLOR_GRADE_FILTER_NAME,
    isEnabled: options?.isEnabled ?? true,
    parameters: persistedParameters,
  });
}

const grade: ExtensionColorGradeApi = Object.freeze({
  filterName: COLOR_GRADE_FILTER_NAME,
  defaults: DEFAULT_COLOR_GRADE_PARAMETERS,
  parseTransform,
  normalize: normalizeGrade,
  normalizePatch: normalizeGradePatch,
  resolve: resolveGrade,
  toTransformInput,
});

/**
 * The host's own color implementation, handed to extensions so their
 * calculations run the same code as the renderer rather than a copy of it.
 */
export const extensionColorApi: ExtensionColorApi = Object.freeze({
  grade,

  createReferenceColorGradeEvaluator,
  applyReferenceColorGradePixel,

  bakeColorGradeCube,
  parseCubeLut,
  serializeCubeLut,
  sampleCubeLut,
  createIdentityCubeLut,

  COLOR_HISTOGRAM_BIN_COUNT,
  buildColorHistograms,

  createColorCurveSampler,
  bakeColorCurveLut,

  srgbToLinear,
  linearToSrgb,
  whiteBalanceMatrix,
  applyMatrix3,
});
