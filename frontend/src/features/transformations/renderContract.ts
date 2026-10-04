import { z } from "zod";
import {
  COLOR_GRADE_PARAMETER_NAMES,
  getColorGradeParameterKind,
  V1_AUTHORED_COLOR_MODEL,
} from "../../core/color";
import { effectMaskSchema } from "../masks/renderContract";

/** Equal to the grade definition's `COLOR_GRADE_FILTER_NAME`, without loading its filter. */
export const COLOR_GRADE_RENDER_FILTER_NAME = "ColorGradeFilter";

/**
 * The transformations feature's part of the detached render contract: the
 * built-in transforms a detached render is qualified to draw, with the
 * parameter shapes each one's handler reads, animated or not.
 *
 * A transform missing here is refused rather than rendered without, and
 * parameters are strict: a handler that sets filter fields from its
 * parameters would otherwise pass an unqualified value straight to the GPU.
 */

const id = z.string().min(1).max(200);
const MAX_MAGNITUDE = 1_000_000;
const MAX_POINTS = 10_000;
/** Spatial and parameter values: finite and bounded, never clamped. */
const scalar = z.number().min(-MAX_MAGNITUDE).max(MAX_MAGNITUDE);

/**
 * A keyframe curve. Times are source ticks for parameters and normalized
 * progress for a path's timing, and interpolation is the renderer's; both
 * are only required to be finite here.
 */
function splineOf(value: z.ZodNumber) {
  return z.strictObject({
    type: z.literal("spline"),
    points: z.array(z.strictObject({ time: scalar, value })).min(1).max(MAX_POINTS),
  });
}

/** A constant, or a spline whose every value satisfies the same bounds. */
function animatable(value: z.ZodNumber = scalar) {
  return z.union([value, splineOf(value)]);
}

const point = z.strictObject({ x: scalar, y: scalar });
const positionPath = z.strictObject({
  type: z.literal("path2d"),
  curve: z.literal("centripetal_catmull_rom"),
  controlPoints: z.array(point).min(1).max(MAX_POINTS),
  timing: splineOf(scalar),
});

const transformBase = {
  id,
  isEnabled: z.boolean(),
  // Fractional: keyframes sit at source time, which retiming need not keep on
  // a tick. They mark where the user placed keys; the values are the splines.
  keyframeTimes: z.array(scalar).max(MAX_POINTS).default([]),
};
const templateId = z.enum(["contain", "cover"]).nullable().default(null);

const position = z.strictObject({ ...transformBase, type: z.literal("position"), templateId,
  parameters: z.strictObject({ x: animatable(), y: animatable(), path: positionPath.optional() }) });
const scale = z.strictObject({ ...transformBase, type: z.literal("scale"), templateId,
  parameters: z.strictObject({ x: animatable(), y: animatable(), isLinked: z.boolean().default(true) }) });
const rotation = z.strictObject({ ...transformBase, type: z.literal("rotation"), templateId,
  parameters: z.strictObject({ angle: animatable() }) });
const fitMode = z.strictObject({ ...transformBase, type: z.literal("fitMode"),
  parameters: z.strictObject({ fitMode: z.enum(["contain", "cover"]) }) });
const opacity = z.strictObject({ ...transformBase, type: z.literal("opacity"),
  parameters: z.strictObject({ opacity: animatable(z.number().min(0).max(1)) }) });
const BLEND_MODES = ["normal", "add", "multiply", "screen"] as const;
const blendMode = z.strictObject({ ...transformBase, type: z.literal("blendMode"),
  parameters: z.strictObject({ blendMode: z.enum(BLEND_MODES) }) });
const volume = z.strictObject({ ...transformBase, type: z.literal("volume"),
  parameters: z.strictObject({ gain: animatable(z.number().min(0).max(2)) }) });

function colorGradeParameters() {
  const shape: Record<string, z.ZodType> = {
    colorModel: z.strictObject({
      version: z.literal(V1_AUTHORED_COLOR_MODEL.version),
      gradingSpace: z.literal(V1_AUTHORED_COLOR_MODEL.gradingSpace),
    }).optional(),
  };
  // The grade schema owns which fields exist and what kind each is. Missing
  // fields take the grade's defaults in the renderer, as they do in the editor.
  for (const name of COLOR_GRADE_PARAMETER_NAMES) {
    const kind = getColorGradeParameterKind(name);
    shape[name] = (kind === "number" ? animatable()
      : kind === "boolean" ? z.boolean()
        : kind === "curve" ? z.array(point).min(1).max(256)
          : id.nullable()).optional();
  }
  return z.strictObject(shape);
}

/**
 * Filters carry an effect mask when they are masked; the mask expression is
 * checked against the clip's own masks by the masks feature.
 */
function filter<Name extends string>(filterName: Name, parameters: z.ZodType) {
  return z.strictObject({ ...transformBase, type: z.literal("filter"),
    filterName: z.literal(filterName), parameters, effectMask: effectMaskSchema.optional() });
}

const blur = filter("BlurFilter", z.strictObject({
  strength: animatable(z.number().min(0).max(20)), quality: z.number().int().min(1).max(10) }));
const alpha = filter("AlphaFilter", z.strictObject({ alpha: animatable(z.number().min(0).max(1)) }));
const colorGrade = filter(COLOR_GRADE_RENDER_FILTER_NAME, colorGradeParameters());
const hslAdjustment = filter("HslAdjustmentFilter", z.strictObject({
  hue: animatable(), saturation: animatable(), lightness: animatable(),
  alpha: animatable(z.number().min(0).max(1)) }).partial());
const colorAdjustment = filter("AdjustmentFilter", z.strictObject({
  red: animatable(), green: animatable(), blue: animatable(), alpha: animatable(z.number().min(0).max(1)),
  gamma: animatable(), contrast: animatable(), saturation: animatable(), brightness: animatable() }).partial());

const FILTERS = [blur, alpha, colorGrade, hslAdjustment, colorAdjustment] as const;
const TRANSFORMS = [position, scale, rotation, fitMode, opacity, blendMode, volume] as const;

/** Filters an adjustment clip can apply to what it reaches. */
export const adjustmentTransformSchema = z.union(FILTERS);

/** Everything a media clip may carry. Clip-type restrictions are the renderer's refinement. */
export const mediaTransformSchema = z.union([...TRANSFORMS, ...FILTERS]);

/** For naming what is not qualified; derived from the schemas above, not listed twice. */
export const QUALIFIED_TRANSFORM_TYPES: ReadonlySet<string> =
  new Set(TRANSFORMS.map((schema) => schema.shape.type.value));
export const QUALIFIED_FILTER_NAMES: ReadonlySet<string> =
  new Set(FILTERS.map((schema) => schema.shape.filterName.value));
export const QUALIFIED_BLEND_MODES: ReadonlySet<string> = new Set(BLEND_MODES);

/** A mask clip is placed like a clip. */
export const maskShapeTransformSchema = z.union([position, scale, rotation]);

const MASK_EDGES = [
  z.strictObject({ ...transformBase, type: z.literal("feather"), parameters: z.strictObject({
    mode: z.enum(["hard_outer", "soft_inner", "two_way"]).optional(),
    amount: animatable(z.number().min(0).max(10_000)),
    invert: z.boolean().optional() }) }),
  z.strictObject({ ...transformBase, type: z.literal("mask_grow"), parameters: z.strictObject({
    amount: animatable(z.number().min(-10_000).max(10_000)),
    invert: z.boolean().optional() }) }),
] as const;

/** Edge operations applied after a clip's masks are composed. */
export const maskCompositionTransformSchema = z.union(MASK_EDGES);
export const QUALIFIED_MASK_EDGE_TYPES: ReadonlySet<string> =
  new Set(MASK_EDGES.map((schema) => schema.shape.type.value));

export type MediaRenderTransform = z.infer<typeof mediaTransformSchema>;

/**
 * Keys older editors left in layout parameters. Their handlers read only
 * `x`/`y` (and `path`), so these never reached a frame; they are named
 * exactly so an unknown key is still refused.
 */
const LEGACY_IGNORED_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  position: ["_"],
  scale: ["angle"],
};

type LooseTransform = { type?: unknown; parameters?: unknown };

/** Drops the legacy keys above from one transform; everything else is left for the schema. */
export function withoutLegacyTransformParameters<T extends LooseTransform>(transform: T): T {
  const ignored = LEGACY_IGNORED_PARAMETERS[String(transform.type)];
  const parameters = transform.parameters as Record<string, unknown> | undefined;
  if (!ignored || !parameters || !ignored.some((key) => key in parameters)) return transform;
  return { ...transform, parameters: Object.fromEntries(
    Object.entries(parameters).filter(([key]) => !ignored.includes(key))) };
}

/** Transform types that only change sound; the rest draw and need a visual clip. */
export const AUDIO_RENDER_TRANSFORM_TYPES: ReadonlySet<string> = new Set(["volume"]);

/**
 * Assets a transform reads besides its clip's media. The colour grade's LUT
 * is the only one today; a new resource-bearing parameter must be added here
 * or a detached render will not be handed its bytes.
 */
export function transformAssetIds(transform: {
  type: string; filterName?: string; parameters: unknown;
}): string[] {
  if (transform.type === "filter" && transform.filterName === COLOR_GRADE_RENDER_FILTER_NAME) {
    const lutAssetId = (transform.parameters as { lutAssetId?: string | null }).lutAssetId;
    return lutAssetId ? [lutAssetId] : [];
  }
  return [];
}
