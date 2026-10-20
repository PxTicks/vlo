import { z } from "zod";

/**
 * The masks feature's part of the detached render contract: what a mask
 * clip, its parent's mask components and an effect mask may contain when a
 * project is rendered away from the editor, and which assets they need.
 *
 * Zod only, so preflight and a detached render bootstrap can load it
 * without the mask runtime. Transform shapes belong to the
 * transformations feature; the renderer's snapshot schema passes them in.
 */

const id = z.string().min(1).max(200);
const MAX_TICKS = 86_400 * 96_000;
const sourceTick = z.number().min(0).max(MAX_TICKS);

/** `${parentClipId}::mask::${localMaskId}`, as the timeline mints them. */
export const MASK_CLIP_ID_SEPARATOR = "::mask::";

export function maskLocalId(maskClipId: string): string {
  const index = maskClipId.lastIndexOf(MASK_CLIP_ID_SEPARATOR);
  return index < 0 ? maskClipId : maskClipId.slice(index + MASK_CLIP_ID_SEPARATOR.length);
}

type MaskExpression =
  | { kind: "mask_ref"; maskId: string; inverted?: boolean }
  | { kind: "operation"; operator: "union" | "intersect" | "subtract"; left: MaskExpression; right: MaskExpression };

export const maskBooleanExpressionSchema: z.ZodType<MaskExpression> = z.lazy(() => z.union([
  z.strictObject({ kind: z.literal("mask_ref"), maskId: id, inverted: z.boolean().optional() }),
  z.strictObject({
    kind: z.literal("operation"),
    operator: z.enum(["union", "intersect", "subtract"]),
    left: maskBooleanExpressionSchema,
    right: maskBooleanExpressionSchema,
  }),
]));

export const effectMaskSchema = z.strictObject({
  enabled: z.boolean(),
  expression: maskBooleanExpressionSchema.nullable(),
  mode: z.literal("composite"),
});

export function maskExpressionIds(expression: MaskExpression | null | undefined): string[] {
  if (!expression) return [];
  return expression.kind === "mask_ref"
    ? [expression.maskId]
    : [...maskExpressionIds(expression.left), ...maskExpressionIds(expression.right)];
}

const componentBase = { id, isEnabled: z.boolean().optional() };

export function createMaskComponentSchema(compositionTransform: z.ZodType) {
  return z.discriminatedUnion("type", [
    z.strictObject({ ...componentBase, type: z.literal("mask_ref"),
      parameters: z.strictObject({ maskClipId: id }) }),
    z.strictObject({ ...componentBase, type: z.literal("mask_composition"),
      parameters: z.strictObject({
        expression: maskBooleanExpressionSchema.nullable().optional(),
        expressionEnabled: z.boolean().optional(),
        algebra: z.enum(["normal", "inverse"]).optional(),
        compositeTransformations: z.array(compositionTransform).max(64),
      }) }),
    z.strictObject({ ...componentBase, type: z.literal("range_mask"),
      parameters: z.strictObject({
        startSourceTicks: sourceTick, endSourceTicks: sourceTick, isActive: z.boolean(),
        name: z.string().max(255).optional(),
      }) }),
  ]);
}

const bounds = z.strictObject({
  x: z.number().min(-1_000_000).max(1_000_000), y: z.number().min(-1_000_000).max(1_000_000),
  width: z.number().min(0).max(1_000_000), height: z.number().min(0).max(1_000_000),
});

/** Mask fields that render. Timing and transforms come from the caller. */
export const maskClipFields = {
  type: z.literal("mask"),
  parentClipId: id,
  maskType: z.enum(["circle", "rectangle", "triangle", "sam2", "generation", "brush"]),
  maskMode: z.enum(["apply", "preview"]),
  maskInverted: z.boolean(),
  sam2GrowAmount: z.number().min(-10_000).max(10_000).optional(),
  maskParameters: z.strictObject({
    baseWidth: z.number().positive().max(1_000_000),
    baseHeight: z.number().positive().max(1_000_000),
  }),
  sam2MaskAssetId: id.optional(),
  generationMaskAssetId: id.optional(),
  brushMaskAssetId: id.optional(),
  brushPaintedBounds: bounds.optional(),
  activeRange: z.strictObject({ startSourceTicks: sourceTick, endSourceTicks: sourceTick }).optional(),
};

/**
 * SAM2 prompts and generation bookkeeping: inputs to making a mask asset, not
 * to drawing one. Projection drops them so a render never depends on, or
 * reruns, the model that produced the mask.
 */
const MASK_AUTHORING_FIELDS = ["maskPoints", "sam2GeneratedPointsHash", "sam2LastGeneratedAt"] as const;
/** Markers annotate a clip's timeline; they draw nothing. */
const NON_RENDER_COMPONENT_TYPES = new Set(["markers"]);

type LooseRecord = Record<string, unknown>;

/** Drops known authoring-only mask data. Unknown fields are left for the schema to refuse. */
export function withoutMaskAuthoringData(clip: LooseRecord): LooseRecord {
  let result = clip;
  if (clip.type === "mask" && MASK_AUTHORING_FIELDS.some((field) => field in clip)) {
    result = { ...clip };
    for (const field of MASK_AUTHORING_FIELDS) delete result[field];
  }
  if (Array.isArray(clip.components) && clip.components.some((component: unknown) =>
    NON_RENDER_COMPONENT_TYPES.has(String((component as LooseRecord | null)?.type)))) {
    result = { ...result, components: clip.components.filter((component: unknown) =>
      !NON_RENDER_COMPONENT_TYPES.has(String((component as LooseRecord | null)?.type))) };
  }
  return result;
}

/** The asset the active mask type draws from; other ids on the clip are stale history. */
export function maskAssetId(clip: {
  maskType: string; sam2MaskAssetId?: string; generationMaskAssetId?: string; brushMaskAssetId?: string;
}): string | null {
  if (clip.maskType === "sam2") return clip.sam2MaskAssetId ?? null;
  if (clip.maskType === "generation") return clip.generationMaskAssetId ?? null;
  if (clip.maskType === "brush") return clip.brushMaskAssetId ?? null;
  return null;
}

interface MaskTopologyClip {
  id: string;
  type: string;
  trackId: string;
  parentClipId?: string;
  maskType?: string;
  components?: readonly { type: string; parameters: unknown; isEnabled?: boolean }[];
  transformations?: readonly { id: string; effectMask?: { expression: MaskExpression | null } }[];
}

/**
 * Render semantics the schema cannot state: every mask belongs to exactly the
 * clip that references it, on that clip's track, and every expression names a
 * mask its clip owns. A dangling reference would otherwise render as an
 * unmasked clip.
 */
export function refineMaskTopology(
  clips: readonly MaskTopologyClip[],
  issue: (message: string) => void,
): void {
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const referencedBy = new Map<string, string>();
  for (const clip of clips) {
    if (clip.type === "mask") continue;
    const ownedLocalIds = new Set<string>();
    for (const component of clip.components ?? []) {
      if (component.type !== "mask_ref") continue;
      const maskClipId = (component.parameters as { maskClipId: string }).maskClipId;
      const mask = byId.get(maskClipId);
      if (!mask || mask.type !== "mask" || mask.parentClipId !== clip.id) {
        issue(`Clip '${clip.id}' references a mask it does not own.`);
        continue;
      }
      if (referencedBy.has(maskClipId)) issue(`Mask '${maskClipId}' is referenced twice.`);
      referencedBy.set(maskClipId, clip.id);
      ownedLocalIds.add(maskLocalId(maskClipId));
    }
    const expressions = [
      ...(clip.components ?? []).filter((component) => component.type === "mask_composition")
        .map((component) => (component.parameters as { expression?: MaskExpression | null }).expression),
      ...(clip.transformations ?? []).map((transform) => transform.effectMask?.expression),
    ];
    for (const maskId of expressions.flatMap(maskExpressionIds)) {
      if (!ownedLocalIds.has(maskId)) issue(`Clip '${clip.id}' composes mask '${maskId}', which it does not own.`);
    }
  }
  for (const clip of clips) {
    if (clip.type !== "mask") continue;
    const parent = clip.parentClipId ? byId.get(clip.parentClipId) : undefined;
    if (!parent || parent.type === "mask" || referencedBy.get(clip.id) !== parent.id) {
      issue(`Mask '${clip.id}' is not attached to its parent clip.`);
    } else if (parent.trackId !== clip.trackId) {
      issue(`Mask '${clip.id}' is not on its parent clip's track.`);
    }
  }
}
