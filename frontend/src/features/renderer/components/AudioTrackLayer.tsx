import { memo } from "react";
import { useAudioTrack } from "../hooks/useAudioTrack";

interface AudioTrackLayerProps {
  trackId: string;
}

export const AudioTrackLayer = memo(function AudioTrackLayer({
  trackId,
}: AudioTrackLayerProps) {
  useAudioTrack(trackId);
  return null; // Audio is invisible
});
