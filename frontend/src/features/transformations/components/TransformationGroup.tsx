import { memo, useCallback } from "react";
import type { ReactNode } from "react";
import { ControlGroup } from "../../panelUI/components/ControlGroup";
import { ControlRenderer } from "./ControlRenderer";
import type { LayoutGroup, ControlRenderProps } from "../../panelUI/types";
import type {
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { useGroupKeyframeManager } from "../hooks/useGroupKeyframeManager";

interface TransformationGroupProps {
  group: LayoutGroup;
  transform: ClipTransform | undefined;
  disabled?: boolean;
  headerActions?: ReactNode;
  disableKeyframe?: boolean;
  onCommit: (
    groupId: string,
    controlName: string,
    value: unknown,
    transformId?: string,
  ) => void;
  minTime?: number;
  duration?: number;
  clipId?: string;
  timelineClip?: TimelineClip;
  targetTransforms?: ClipTransform[];
  onUpdateTransform?: (
    transformId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;
  onSetTransforms?: (nextTransforms: ClipTransform[]) => void;
  keyframeColor?: string;
  onGroupEdited?: () => void;
  captureSnapshot?: () => unknown | null;
  restoreSnapshot?: (snapshot: unknown) => void;
}

export const TransformationGroup = memo(function TransformationGroup({
  group,
  transform,
  disabled = false,
  headerActions,
  disableKeyframe = false,
  onCommit,
  minTime,
  duration,
  clipId,
  timelineClip,
  targetTransforms,
  onUpdateTransform,
  onSetTransforms,
  keyframeColor,
  onGroupEdited,
  captureSnapshot,
  restoreSnapshot,
}: TransformationGroupProps) {
  const keyframeManager = useGroupKeyframeManager({
    group,
    transform,
    clipId,
    timelineClip,
    targetTransforms,
    onUpdateTransform,
    onSetTransforms,
    onToggleKeyframe: onGroupEdited,
  });

  // Adapt: extract parameters from ClipTransform
  const values = transform?.parameters ?? {};

  // Adapt: wrap onCommit to include transformId
  const handleCommit = useCallback(
    (groupId: string, controlName: string, value: unknown) => {
      onGroupEdited?.();
      onCommit(groupId, controlName, value, transform?.id);
    },
    [onGroupEdited, onCommit, transform?.id],
  );

  // Render prop: delegate control rendering to the transformation-specific ControlRenderer.
  // Live spline values are now fed back via liveParamStore (DOM refs), so keyframeTime is
  // no longer a prop — this callback is stable across playback and does not cause re-renders.
  const renderControl = useCallback(
    (props: ControlRenderProps) => (
      <ControlRenderer
        control={props.control}
        value={props.value}
        onCommit={props.onCommit}
        groupId={props.groupId}
        transformId={transform?.id}
        clipId={clipId}
        minTime={minTime}
        duration={duration}
        disabled={disabled}
        captureSnapshot={captureSnapshot}
        restoreSnapshot={restoreSnapshot}
      />
    ),
    [
      captureSnapshot,
      clipId,
      disabled,
      duration,
      minTime,
      restoreSnapshot,
      transform?.id,
    ],
  );

  return (
    <ControlGroup
      group={group}
      values={values}
      onCommit={handleCommit}
      renderControl={renderControl}
      headerActions={headerActions}
      disabled={disabled}
      keyframe={{
        enabled: keyframeManager.enabled,
        active: keyframeManager.active,
        onToggle: keyframeManager.toggleKeyframe,
        color: keyframeColor,
        disabled: disableKeyframe,
      }}
    />
  );
});
