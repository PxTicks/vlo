import { Box } from "@mui/material";
import { SortableSection } from "../../panelUI/components/SortableSection";
import { TransformationGroup } from "./TransformationGroup";
import { EffectMaskControl } from "./EffectMaskControl";
import { TransformationResetButton } from "./TransformationResetButton";
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
  groups: readonly LayoutGroup[];
  title: string;
  bgColor: string;
  onRemove?: () => void;
  /** Present for sections that stay in the stack and reset in place. */
  onReset?: () => void;
  onCommit: (
    groupId: string,
    controlName: string,
    val: unknown,
    transformId?: string,
  ) => void;
  onCommitMany?: (
    groupId: string,
    values: Readonly<Record<string, unknown>>,
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
  onReset,
  onCommit,
  onCommitMany,
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
  const effectMaskAction = supportsEffectMask(transform, timelineClip) ? (
    <EffectMaskControl
      transform={transform}
      clipId={clipId}
      transformTitle={title}
      onUpdateTransform={onUpdateTransform}
    />
  ) : null;

  const headerActions =
    effectMaskAction || onReset ? (
      <>
        {effectMaskAction}
        {onReset ? (
          <TransformationResetButton
            label={`Reset ${title}`}
            tooltip={`Reset ${title} to defaults`}
            onReset={onReset}
          />
        ) : null}
      </>
    ) : null;

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
      headerActions={headerActions}
      showDragHandle={false}
      sectionToggle={{
        checked: isEnabled,
        onChange: onToggleEnabled,
        ariaLabel: `${title} enabled`,
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {groups.map((group) => (
          <TransformationGroup
            key={group.id}
            group={group}
            transform={transform}
            onCommit={onCommit}
            onCommitMany={onCommitMany}
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
