import { Box } from "@mui/material";
import { SortableSection } from "../../panelUI/components/SortableSection";
import { TransformationGroup } from "./TransformationGroup";
import { EffectMaskControl } from "./EffectMaskControl";
import type {
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import type { LayoutGroup } from "../../panelUI/types";

/**
 * Effect masking applies to clip-local filter transforms only (v1): speed,
 * layout, blend, volume are excluded, as are adjustment clips and mask targets.
 */
function supportsEffectMask(
  transform: ClipTransform,
  timelineClip: TimelineClip | undefined,
): boolean {
  return (
    transform.type === "filter" &&
    !!timelineClip &&
    timelineClip.type !== "adjustment" &&
    timelineClip.type !== "mask"
  );
}

interface SortableTransformationItemProps {
  id: string;
  transform: ClipTransform;
  groups: LayoutGroup[];
  title: string;
  bgColor: string;
  onRemove: () => void;
  onCommit: (
    groupId: string,
    controlName: string,
    val: unknown,
    transformId?: string,
  ) => void;
  minTime?: number;
  duration?: number;
  clipId: string | undefined;
  timelineClip?: TimelineClip;
  targetTransforms?: ClipTransform[];
  onUpdateTransform?: (
    transformId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;
  onSetTransforms?: (nextTransforms: ClipTransform[]) => void;
  isPanelDragging: boolean;
  isOpen: boolean;
  onToggle: () => void;
  isEnabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  isActiveSection: boolean;
  onSectionClick: () => void;
  keyframeColor: string;
  captureSnapshot?: () => unknown | null;
  restoreSnapshot?: (snapshot: unknown) => void;
}

export function SortableTransformationItem({
  id,
  transform,
  groups,
  title,
  bgColor,
  onRemove,
  onCommit,
  minTime,
  duration,
  isPanelDragging,
  isOpen,
  onToggle,
  isEnabled,
  onToggleEnabled,
  clipId,
  timelineClip,
  targetTransforms,
  onUpdateTransform,
  onSetTransforms,
  isActiveSection,
  onSectionClick,
  keyframeColor,
  captureSnapshot,
  restoreSnapshot,
}: SortableTransformationItemProps) {
  return (
    <SortableSection
      id={id}
      title={title}
      bgColor={bgColor}
      onRemove={onRemove}
      isPanelDragging={isPanelDragging}
      isOpen={isOpen}
      onToggle={onToggle}
      isActive={isActiveSection}
      onSectionClick={onSectionClick}
      sectionToggle={{
        checked: isEnabled,
        onChange: onToggleEnabled,
        ariaLabel: `${title} enabled`,
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {supportsEffectMask(transform, timelineClip) && (
          <EffectMaskControl
            transform={transform}
            clipId={clipId}
            transformTitle={title}
            onUpdateTransform={onUpdateTransform}
          />
        )}
        {groups.map((group) => (
          <TransformationGroup
            key={group.id}
            group={group}
            transform={transform}
            onCommit={onCommit}
            minTime={minTime}
            duration={duration}
            clipId={clipId}
            timelineClip={timelineClip}
            targetTransforms={targetTransforms}
            onUpdateTransform={onUpdateTransform}
            onSetTransforms={onSetTransforms}
            keyframeColor={keyframeColor}
            onGroupEdited={onSectionClick}
            captureSnapshot={captureSnapshot}
            restoreSnapshot={restoreSnapshot}
          />
        ))}
      </Box>
    </SortableSection>
  );
}
