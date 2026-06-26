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

export function DefaultTransformationSections({
  definitions,
  activeTransforms,
  activeContextId,
  activeSectionId,
  timelineClip,
  onCommit,
  onSetDefaultGroupsEnabled,
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

    return (
      <TransformationSection
        key={section.sectionId}
        title={section.title}
        defaultOpen={true}
        bgColor="#18181b"
        dimmed={dimmed}
        isActive={activeSectionId === section.sectionId}
        onSectionClick={() => onActivateSection(section.sectionId)}
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
            const domain = getTransformLayerDomain(timelineClip, transform?.id);

            return (
              <TransformationGroup
                key={`${definition.type}:${group.id}`}
                group={group}
                transform={transform}
                disabled={groupProps.disabled}
                disableKeyframe={groupProps.disableKeyframe}
                headerActions={groupProps.headerActions}
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
