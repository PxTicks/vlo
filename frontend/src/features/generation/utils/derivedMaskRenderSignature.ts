import type { DerivedMaskMapping } from "../pipeline/types";

type DerivedMaskRenderSignatureMapping = Pick<
  DerivedMaskMapping,
  | "maskType"
  | "purpose"
  | "renderFps"
  | "sourceSelection"
  | "maskSelection"
  | "sourceVideoTreatment"
  | "optional"
>;

function normalizeRenderMode(
  mode: DerivedMaskMapping["sourceSelection"] | DerivedMaskMapping["maskSelection"],
): "input_selection" | "full_selection" {
  return mode === "full_selection" ? "full_selection" : "input_selection";
}

function normalizePurpose(
  purpose: DerivedMaskMapping["purpose"],
): "video" | "audio_timing" {
  return purpose === "audio_timing" ? "audio_timing" : "video";
}

function normalizeSourceVideoTreatment(
  treatment: DerivedMaskMapping["sourceVideoTreatment"],
): "preserve_transparency" | "remove_transparency" {
  return treatment === "preserve_transparency"
    ? "preserve_transparency"
    : "remove_transparency";
}

/**
 * Prepared selection renders are workflow-dependent: the same timeline
 * selection can legitimately produce different source/mask files once a
 * workflow starts requesting alternate source/mask selection modes. Capture a
 * small stable signature so submit-time preprocess can tell whether cached
 * prepared files still match the current derived-mask semantics.
 */
export function buildDerivedMaskRenderSignature(
  mappings: readonly DerivedMaskRenderSignatureMapping[],
): string | null {
  if (mappings.length === 0) {
    return null;
  }

  const normalizedMappings = mappings
    .map((mapping) => ({
      maskSelection: normalizeRenderMode(mapping.maskSelection),
      maskType: mapping.maskType === "soft" ? "soft" : "binary",
      optional: mapping.optional === true,
      purpose: normalizePurpose(mapping.purpose),
      renderFps:
        typeof mapping.renderFps === "number" &&
        Number.isFinite(mapping.renderFps) &&
        mapping.renderFps > 0
          ? Math.round(mapping.renderFps)
          : null,
      sourceSelection: normalizeRenderMode(mapping.sourceSelection),
      sourceVideoTreatment: normalizeSourceVideoTreatment(
        mapping.sourceVideoTreatment,
      ),
    }))
    .sort((left, right) =>
      [
        left.purpose,
        left.maskType,
        left.renderFps ?? "",
        left.sourceSelection,
        left.maskSelection,
        left.sourceVideoTreatment,
        left.optional ? "1" : "0",
      ]
        .join(":")
        .localeCompare(
          [
            right.purpose,
            right.maskType,
            right.renderFps ?? "",
            right.sourceSelection,
            right.maskSelection,
            right.sourceVideoTreatment,
            right.optional ? "1" : "0",
          ].join(":"),
        ),
    );

  return JSON.stringify(normalizedMappings);
}
