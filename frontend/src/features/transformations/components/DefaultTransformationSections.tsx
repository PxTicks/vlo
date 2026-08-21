import { Box } from "@mui/material";
import type { ReactNode } from "react";
import type {
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import type { TransformationDefinition } from "../catalogue/types";
import { getTransformLayerDomain } from "../utils/layerDomain";
import { getSectionGroupKeyframeColor } from "../utils/sectionKeyframes";
import { getDefaultTransformationSectionModels } from "../utils/defaultSectionModels";
import { TransformationGroup } from "./TransformationGroup";
import { TransformationResetButton } from "./TransformationResetButton";
import { TransformationSection } from "./TransformationSection";

interface DefaultTransformationSectionsProps {
  definitions: TransformationDefinition[];
  activeTransforms: ClipTransform[];
  activeContextId: string | undefined;
  activeSectionId: string | null;
  timelineClip?: TimelineClip;
  onCommit: (
    groupId: string,
    controlName: string,
    value: unknown,
    transformId?: string,
  ) => void;
  onSetDefaultGroupsEnabled: (groupIds: string[], enabled: boolean) => void;
  /** Drop the stored transforms for these groups, returning them to defaults. */
  onResetDefaultGroups?: (groupIds: string[]) => void;
  onUpdateTransform?: (
    transformId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;
  onSetTransforms?: (nextTransforms: ClipTransform[]) => void;
  onActivateSection: (sectionId: string) => void;
  dimmed?: boolean;
  getGroupProps?: (
    groupId: string,
    transform: ClipTransform | undefined,
  ) => {
    disabled?: boolean;
    disableKeyframe?: boolean;
    headerActions?: ReactNode;
  };
  captureSnapshot?: () => unknown | null;
  restoreSnapshot?: (snapshot: unknown) => void;
}

/**
 * Group titles are display-shouty ("SCALE (Multiplier)"), so reset affordances
 * label themselves from the group id instead: "blendMode" -> "Blend Mode".
 */
function humanizeGroupId(groupId: string): string {
  return groupId
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

export function DefaultTransformationSections({
  definitions,
  activeTransforms,
  activeContextId,
  activeSectionId,
  timelineClip,
  onCommit,
  onSetDefaultGroupsEnabled,
  onResetDefaultGroups,
  onUpdateTransform,
  onSetTransforms,
  onActivateSection,
  dimmed = false,
  getGroupProps,
  captureSnapshot,
  restoreSnapshot,
}: DefaultTransformationSectionsProps) {
  return getDefaultTransformationSectionModels(definitions).map((section) => {
    const groupItems = section.definitions.flatMap((definition) =>
      definition.uiConfig.groups.map((group) => ({ definition, group })),
    );
    const groupIds = groupItems.map((item) => item.group.id);
    const isSectionEnabled = groupIds.every((groupId) => {
      const transform = activeTransforms.find((item) => item.type === groupId);
      return transform?.isEnabled ?? true;
    });

    // A group is only resettable once it carries a stored transform — an
    // absent transform already renders at its defaults.
    const resettableGroupIds = groupIds.filter((groupId) =>
      activeTransforms.some((item) => item.type === groupId),
    );

    return (
      <TransformationSection
        key={section.sectionId}
        title={section.title}
        defaultOpen={true}
        bgColor="#18181b"
        dimmed={dimmed}
        isActive={activeSectionId === section.sectionId}
        onSectionClick={() => onActivateSection(section.sectionId)}
        headerActions={
          onResetDefaultGroups && resettableGroupIds.length > 0 ? (
            <TransformationResetButton
              label={`Reset ${section.title}`}
              tooltip={`Reset ${section.title} to defaults`}
              onReset={() => onResetDefaultGroups(resettableGroupIds)}
            />
          ) : undefined
        }
        sectionToggle={{
          checked: isSectionEnabled,
          onChange: (enabled) => onSetDefaultGroupsEnabled(groupIds, enabled),
          ariaLabel: `${section.title} enabled`,
        }}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: section.hideGroupTitles ? 1 : 2,
          }}
        >
          {groupItems.map(({ definition, group }, groupIndex) => {
            const transform = activeTransforms.find(
              (item) => item.type === group.id,
            );
            const groupProps = getGroupProps?.(group.id, transform) ?? {};
            // Per-group reset sits beside any group-specific header actions;
            // the section header resets every group at once.
            const groupHeaderActions =
              onResetDefaultGroups && transform ? (
                <>
                  {groupProps.headerActions}
                  <TransformationResetButton
                    label={`Reset ${humanizeGroupId(group.id)}`}
                    tooltip={`Reset ${humanizeGroupId(group.id)} to defaults`}
                    onReset={() => onResetDefaultGroups([group.id])}
                  />
                </>
              ) : (
                groupProps.headerActions
              );
            const domain = getTransformLayerDomain(timelineClip, transform?.id);

            return (
              <TransformationGroup
                key={`${definition.type}:${group.id}`}
                group={group}
                transform={transform}
                disabled={groupProps.disabled}
                disableKeyframe={groupProps.disableKeyframe}
                headerActions={groupHeaderActions}
                hideTitle={section.hideGroupTitles}
                onCommit={onCommit}
                minTime={domain.minTime}
                duration={domain.duration}
                clipId={activeContextId}
                timelineClip={timelineClip}
                targetTransforms={activeTransforms}
                onUpdateTransform={onUpdateTransform}
                onSetTransforms={onSetTransforms}
                keyframeColor={getSectionGroupKeyframeColor(groupIndex)}
                onGroupEdited={() => onActivateSection(section.sectionId)}
                captureSnapshot={captureSnapshot}
                restoreSnapshot={restoreSnapshot}
              />
            );
          })}
        </Box>
      </TransformationSection>
    );
  });
}
