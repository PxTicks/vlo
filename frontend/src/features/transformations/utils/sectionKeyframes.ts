import type {
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import {
  getDefaultTransforms,
  getEntryForTransform,
} from "../catalogue/TransformationRegistry";
import { mapLayerInputToVisualTime } from "./timeCalculation";

export const SECTION_GROUP_KEYFRAME_COLORS = [
  "#ffb000",
  "#648fff",
  "#dc267f",
  "#f5f5f5",
  "#785ef0",
  "#fe6100",
] as const;

const DEFAULT_SECTION_PREFIX = "default:";
const DYNAMIC_SECTION_PREFIX = "dynamic:";

interface ResolvedSectionGroup {
  groupId: string;
  groupIndex: number;
  transform: ClipTransform;
  color: string;
}

export interface SectionKeyframeMarker {
  id: string;
  groupId: string;
  groupIndex: number;
  transformId: string;
  inputTime: number;
  visualTime: number;
  color: string;
}

export function getSectionGroupKeyframeColor(index: number): string {
  const paletteSize = SECTION_GROUP_KEYFRAME_COLORS.length;
  const normalizedIndex = ((index % paletteSize) + paletteSize) % paletteSize;
  return SECTION_GROUP_KEYFRAME_COLORS[normalizedIndex];
}

export function getDefaultSectionId(definitionType: string): string {
  return `${DEFAULT_SECTION_PREFIX}${definitionType}`;
}

export function getDynamicSectionId(transformId: string): string {
  return `${DYNAMIC_SECTION_PREFIX}${transformId}`;
}

function resolveDefaultSectionGroups(
  clip: TimelineClip,
  definitionType: string,
): ResolvedSectionGroup[] {
  const definition = getDefaultTransforms().find(
    (entry) => entry.type === definitionType,
  );
  if (!definition) return [];

  return definition.uiConfig.groups.flatMap((group, groupIndex) => {
    const transform = clip.transformations.find(
      (candidate) => candidate.type === group.id,
    );
    if (!transform) return [];

    return [
      {
        groupId: group.id,
        groupIndex,
        transform,
        color: getSectionGroupKeyframeColor(groupIndex),
      },
    ];
  });
}

function resolveDynamicSectionGroups(
  clip: TimelineClip,
  transformId: string,
): ResolvedSectionGroup[] {
  const transform = clip.transformations.find(
    (candidate) => candidate.id === transformId,
  );
  if (!transform) return [];

  const entry = getEntryForTransform(transform);
  if (!entry) {
    return [
      {
        groupId: transform.type,
        groupIndex: 0,
        transform,
        color: getSectionGroupKeyframeColor(0),
      },
    ];
  }

  return entry.uiConfig.groups.map((group, groupIndex) => ({
    groupId: group.id,
    groupIndex,
    transform,
    color: getSectionGroupKeyframeColor(groupIndex),
  }));
}

function resolveSectionGroups(
  clip: TimelineClip,
  sectionId: string,
): ResolvedSectionGroup[] {
  if (sectionId.startsWith(DEFAULT_SECTION_PREFIX)) {
    return resolveDefaultSectionGroups(
      clip,
      sectionId.slice(DEFAULT_SECTION_PREFIX.length),
    );
  }

  if (sectionId.startsWith(DYNAMIC_SECTION_PREFIX)) {
    return resolveDynamicSectionGroups(
      clip,
      sectionId.slice(DYNAMIC_SECTION_PREFIX.length),
    );
  }

  return [];
}

export function collectSectionKeyframes(
  clip: TimelineClip,
  sectionId: string,
): SectionKeyframeMarker[] {
  const groups = resolveSectionGroups(clip, sectionId);

  return groups
    .flatMap((group) =>
      (group.transform.keyframeTimes ?? []).map((inputTime, markerIndex) => ({
        id: `${group.transform.id}:${group.groupId}:${inputTime}:${markerIndex}`,
        groupId: group.groupId,
        groupIndex: group.groupIndex,
        transformId: group.transform.id,
        inputTime,
        visualTime: mapLayerInputToVisualTime(
          clip,
          group.transform.id,
          inputTime,
        ),
        color: group.color,
      })),
    )
    .sort((a, b) => {
      if (a.visualTime !== b.visualTime) {
        return a.visualTime - b.visualTime;
      }
      return a.groupIndex - b.groupIndex;
    });
}
