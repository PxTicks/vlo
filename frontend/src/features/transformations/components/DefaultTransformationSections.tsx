import { Box } from "@mui/material";
import type {
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import type { TransformationDefinition } from "../catalogue/types";
import { getTransformLayerDomain } from "../utils/layerDomain";
import {
  getDefaultSectionId,
  getSectionGroupKeyframeColor,
} from "../utils/sectionKeyframes";
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
}: DefaultTransformationSectionsProps) {
  return definitions.map((definition) => {
    const sectionId = getDefaultSectionId(definition.type);
    const groupIds = definition.uiConfig.groups.map((group) => group.id);
    const isSectionEnabled = groupIds.every((groupId) => {
      const transform = activeTransforms.find((item) => item.type === groupId);
      return transform?.isEnabled ?? true;
    });

    return (
      <TransformationSection
        key={definition.type}
        title={definition.label}
        defaultOpen={true}
        bgColor="#18181b"
        dimmed={dimmed}
        isActive={activeSectionId === sectionId}
        onSectionClick={() => onActivateSection(sectionId)}
        sectionToggle={{
          checked: isSectionEnabled,
          onChange: (enabled) => onSetDefaultGroupsEnabled(groupIds, enabled),
          ariaLabel: `${definition.label} enabled`,
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {definition.uiConfig.groups.map((group, groupIndex) => {
            const transform = activeTransforms.find(
              (item) => item.type === group.id,
            );
            const domain = getTransformLayerDomain(timelineClip, transform?.id);

            return (
              <TransformationGroup
                key={group.id}
                group={group}
                transform={transform}
                onCommit={onCommit}
                minTime={domain.minTime}
                duration={domain.duration}
                clipId={activeContextId}
                timelineClip={timelineClip}
                targetTransforms={activeTransforms}
                onUpdateTransform={onUpdateTransform}
                onSetTransforms={onSetTransforms}
                keyframeColor={getSectionGroupKeyframeColor(groupIndex)}
                onGroupEdited={() => onActivateSection(sectionId)}
              />
            );
          })}
        </Box>
      </TransformationSection>
    );
  });
}
