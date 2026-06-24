import type { LivePreviewParamChange } from "../../../core/liveParams/livePreviewParamStore";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { getMaskCompositionComponent } from "../../masks/model/maskBooleanExpression";

export interface LivePreviewRefreshPlan {
  updateClipTransforms: boolean;
  maskClipIds: Set<string>;
  needsFrameGraphRefresh: boolean;
}

/**
 * Classify a transient parameter change by the cheapest renderer boundary that
 * can make it visible without compromising source or mask correctness.
 */
export function createLivePreviewRefreshPlan(
  change: LivePreviewParamChange,
  activeClip: TimelineClip | undefined,
  maskClips: readonly MaskTimelineClip[],
): LivePreviewRefreshPlan | null {
  if (change.kind === "request-render" || change.kind === "clear-all") {
    return {
      updateClipTransforms: false,
      maskClipIds: new Set(),
      needsFrameGraphRefresh: true,
    };
  }
  if (!activeClip) {
    return null;
  }

  let isRelevant = false;
  let needsFrameGraphRefresh = false;
  let updateClipTransforms = false;
  const maskClipIds = new Set<string>();
  const clipTransforms = activeClip.transformations ?? [];
  const compositeTransforms =
    activeClip.type === "mask"
      ? []
      : (getMaskCompositionComponent(activeClip)?.parameters
          .compositeTransformations ?? []);

  for (const parameter of change.parameters) {
    const clipTransform = clipTransforms.find(
      (transform) => transform.id === parameter.transformId,
    );
    if (clipTransform) {
      isRelevant = true;
      if (clipTransform.type === "speed") {
        needsFrameGraphRefresh = true;
      } else {
        updateClipTransforms = true;
      }
      continue;
    }

    const maskOwner = maskClips.find((maskClip) =>
      (maskClip.transformations ?? []).some(
        (transform) => transform.id === parameter.transformId,
      ),
    );
    if (maskOwner) {
      isRelevant = true;
      const maskTransform = (maskOwner.transformations ?? []).find(
        (transform) => transform.id === parameter.transformId,
      );
      if (
        maskTransform?.type === "position" ||
        maskTransform?.type === "scale" ||
        maskTransform?.type === "rotation"
      ) {
        maskClipIds.add(maskOwner.id);
      } else {
        needsFrameGraphRefresh = true;
      }
      continue;
    }

    if (
      compositeTransforms.some(
        (transform) => transform.id === parameter.transformId,
      )
    ) {
      isRelevant = true;
      needsFrameGraphRefresh = true;
    }
  }

  return isRelevant
    ? {
        updateClipTransforms,
        maskClipIds,
        needsFrameGraphRefresh,
      }
    : null;
}
