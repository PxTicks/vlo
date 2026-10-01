import { memo } from "react";
import { useAudioClipLiveParams } from "../hooks/useAudioClipLiveParams";
import type { AdjustmentEffectResolver } from "../services/AdjustmentEffectResolver";

interface AudioLiveParamLayerProps {
  trackId: string;
  adjustmentEffectResolver?: AdjustmentEffectResolver | null;
}

export const AudioLiveParamLayer = memo(function AudioLiveParamLayer({
  trackId,
  adjustmentEffectResolver,
}: AudioLiveParamLayerProps) {
  useAudioClipLiveParams(trackId, adjustmentEffectResolver);
  return null;
});
