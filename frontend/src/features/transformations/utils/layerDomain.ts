import type { TimelineClip } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";
import { getLayerInputDomain } from "./timeCalculation";

interface LayerDomain {
  minTime: number;
  duration: number;
}

const EMPTY_DOMAIN: LayerDomain = {
  minTime: 0,
  duration: 0,
};

function getDomainFallbackDuration(clip: TimelineClip): number {
  return (clip.croppedSourceDuration || 0) / TICKS_PER_SECOND;
}

/**
 * Resolves the input-time domain for a transform layer, with a safe fallback
 * duration when the computed layer domain collapses.
 */
export function getTransformLayerDomain(
  clip: TimelineClip | undefined,
  transformId?: string,
): LayerDomain {
  if (!clip) return EMPTY_DOMAIN;

  const transforms = clip.transformations || [];
  const index = transformId
    ? transforms.findIndex((transform) => transform.id === transformId)
    : 0;
  const effectiveIndex = index === -1 ? 0 : index;
  const layerDomain = getLayerInputDomain(clip, effectiveIndex);

  return {
    minTime: layerDomain.minTime,
    duration:
      layerDomain.duration > 0
        ? layerDomain.duration
        : getDomainFallbackDuration(clip),
  };
}
