import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import { KeyframeToggleButton } from "../../panelUI/components/KeyframeToggleButton";
import { useLayoutKeyframeTrack } from "../hooks/useLayoutKeyframeTrack";

interface LayoutKeyframeButtonProps {
  clipId?: string;
  timelineClip?: TimelineClip;
  targetTransforms?: ClipTransform[];
  onSetTransforms?: (nextTransforms: ClipTransform[]) => void;
  color?: string;
  onToggleKeyframe?: () => void;
}

/**
 * The one keyframe button for position, scale and rotation, which share a
 * keyframe track; it sits in the Layout section header.
 */
export function LayoutKeyframeButton({
  clipId,
  timelineClip,
  targetTransforms,
  onSetTransforms,
  color,
  onToggleKeyframe,
}: LayoutKeyframeButtonProps) {
  const track = useLayoutKeyframeTrack({
    clipId,
    timelineClip,
    targetTransforms,
    onSetTransforms,
    onToggleKeyframe,
  });
  if (!track.enabled) return null;

  return (
    <KeyframeToggleButton
      active={track.active}
      onToggle={track.toggleKeyframe}
      color={color}
    />
  );
}
