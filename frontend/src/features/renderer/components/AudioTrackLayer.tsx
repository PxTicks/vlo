import { memo } from "react";
import { useAudioTrack } from "../hooks/useAudioTrack";
import type { AdjustmentEffectResolver } from "../services/AdjustmentEffectResolver";

interface AudioTrackLayerProps {
  trackId: string;
  adjustmentEffectResolver?: AdjustmentEffectResolver | null;
}

export const AudioTrackLayer = memo(function AudioTrackLayer({
  trackId,
  adjustmentEffectResolver,
}: AudioTrackLayerProps) {
  useAudioTrack(trackId, adjustmentEffectResolver);
  return null; // Audio is invisible
});
