export type DerivedMaskSourceVideoTreatment =
  | "preserve_transparency"
  | "fill_transparent_with_neutral_gray"
  | "remove_transparency";

export const DERIVED_MASK_VIDEO_TREATMENT_WIDGET_PARAM =
  "__derived_mask_video_treatment";

export const DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT: DerivedMaskSourceVideoTreatment =
  "preserve_transparency";

interface DerivedMaskVideoTreatmentWidgetLike {
  nodeId: string;
  param: string;
  currentValue: unknown;
  config: {
    frontendOnly?: boolean;
  };
}

interface DerivedMaskSourceLike {
  sourceNodeId: string;
}

function normalizeTreatmentValue(
  value: unknown,
): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function parseDerivedMaskSourceVideoTreatment(
  value: unknown,
): DerivedMaskSourceVideoTreatment {
  const normalized = normalizeTreatmentValue(value);

  if (
    normalized === "fill_transparent_with_neutral_gray" ||
    normalized === "fill transparent with neutral gray" ||
    normalized === "fill transparent with neutral grey"
  ) {
    return "fill_transparent_with_neutral_gray";
  }

  if (
    normalized === "remove_transparency" ||
    normalized === "remove transparency"
  ) {
    return "remove_transparency";
  }

  return DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT;
}

export function resolveDerivedMaskVideoTreatmentForNode(
  sourceNodeId: string,
  widgetInputs: readonly DerivedMaskVideoTreatmentWidgetLike[],
  widgetValues: Record<string, Record<string, unknown>>,
): DerivedMaskSourceVideoTreatment {
  const widget = widgetInputs.find(
    (candidate) =>
      candidate.nodeId === sourceNodeId &&
      candidate.param === DERIVED_MASK_VIDEO_TREATMENT_WIDGET_PARAM &&
      candidate.config.frontendOnly === true,
  );

  if (!widget) {
    return DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT;
  }

  const currentValue =
    widgetValues[sourceNodeId]?.[DERIVED_MASK_VIDEO_TREATMENT_WIDGET_PARAM] ??
    widget.currentValue;

  return parseDerivedMaskSourceVideoTreatment(currentValue);
}

export function resolveDerivedMaskVideoTreatments(
  derivedMaskMappings: readonly DerivedMaskSourceLike[],
  widgetInputs: readonly DerivedMaskVideoTreatmentWidgetLike[],
  widgetValues: Record<string, Record<string, unknown>>,
): Record<string, DerivedMaskSourceVideoTreatment> {
  const treatments: Record<string, DerivedMaskSourceVideoTreatment> = {};
  const sourceNodeIds = new Set(
    derivedMaskMappings.map((mapping) => mapping.sourceNodeId),
  );

  for (const sourceNodeId of sourceNodeIds) {
    treatments[sourceNodeId] = resolveDerivedMaskVideoTreatmentForNode(
      sourceNodeId,
      widgetInputs,
      widgetValues,
    );
  }

  return treatments;
}
