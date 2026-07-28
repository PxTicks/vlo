import type {
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import type { TransformationDefinition } from "../catalogue/types";
import {
  getDefaultTransforms,
  getEntryForTransform,
} from "../catalogue/TransformationRegistry";
import { clipSourceTimeToVisual } from "./clipTimeDomains";
import { getDefaultTransformationSectionModels } from "./defaultSectionModels";
import {
  DEFAULT_SECTION_PREFIX,
  DYNAMIC_SECTION_PREFIX,
  getDefaultSectionId,
  getDynamicSectionId,
} from "./sectionIds";

export { getDefaultSectionId, getDynamicSectionId };

export const SECTION_GROUP_KEYFRAME_COLORS = [
  "#ffb000",
  "#648fff",
  "#dc267f",
  "#f5f5f5",
  "#785ef0",
  "#fe6100",
] as const;

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
  /** Stored keyframe time, encoded as source-media time in project ticks. */
  inputTime: number;
  visualTime: number;
  color: string;
}

export function getSectionGroupKeyframeColor(index: number): string {
  const paletteSize = SECTION_GROUP_KEYFRAME_COLORS.length;
  const normalizedIndex = ((index % paletteSize) + paletteSize) % paletteSize;
  return SECTION_GROUP_KEYFRAME_COLORS[normalizedIndex];
}

/**
 * The definitions a default section renders, in panel order.
 *
 * Sections are not 1:1 with definitions: "Display" bundles layout, fit mode and
 * blend mode, and "Audio" bundles volume with the audio effects, so their
 * section ids ("default:display", "default:audio") name no definition at all.
 * Resolve through the same section models the panel renders from, and fall back
 * to a bare definition type for panels that address a definition's own section
 * directly (the mask panel's standalone layout section).
 */
function resolveSectionDefinitions(
  sectionType: string,
): TransformationDefinition[] {
  const definitions = getDefaultTransforms();
  const sectionId = getDefaultSectionId(sectionType);
  const section = getDefaultTransformationSectionModels(definitions).find(
    (candidate) => candidate.sectionId === sectionId,
  );
  if (section) return section.definitions;

  const definition = definitions.find((entry) => entry.type === sectionType);
  return definition ? [definition] : [];
}

function resolveDefaultSectionGroups(
  clip: TimelineClip,
  sectionType: string,
): ResolvedSectionGroup[] {
  const resolved: ResolvedSectionGroup[] = [];
  // Group index runs across the whole section, matching the flattened order
  // `DefaultTransformationSections` uses to colour each group's keyframe dot.
  let groupIndex = 0;

  resolveSectionDefinitions(sectionType).forEach((definition) => {
    definition.uiConfig.groups.forEach((group) => {
      const currentGroupIndex = groupIndex;
      groupIndex += 1;

      const transform = clip.transformations.find(
        (candidate) => candidate.type === group.id,
      );
      if (!transform) return;
      if (
        group.id === "position" &&
        typeof transform.parameters === "object" &&
        transform.parameters !== null &&
        "path" in transform.parameters &&
        transform.parameters.path
      ) {
        return;
      }

      resolved.push({
        groupId: group.id,
        groupIndex: currentGroupIndex,
        transform,
        color: getSectionGroupKeyframeColor(currentGroupIndex),
      });
    });
  });

  return resolved;
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
        visualTime: clipSourceTimeToVisual(clip, inputTime),
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
