import { memo } from "react";
import { useAudioTrack } from "../hooks/useAudioTrack";
import type { AdjustmentEffectResolver } from "../services/AdjustmentEffectResolver";
import type { CompositeAudioSourceData } from "../services/CompositeAudioResolver";

interface AudioTrackLayerProps {
  trackId: string;
  adjustmentEffectResolver?: AdjustmentEffectResolver | null;
  compositeSourceData?: CompositeAudioSourceData | null;
}

export const AudioTrackLayer = memo(function AudioTrackLayer({
  trackId,
  adjustmentEffectResolver,
  compositeSourceData,
}: AudioTrackLayerProps) {
  useAudioTrack(trackId, adjustmentEffectResolver, compositeSourceData);
  return null; // Audio is invisible
});
