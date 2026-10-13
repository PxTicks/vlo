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
  isLayoutKeyframeGroupType,
  isLayoutKeyframeTransform,
} from "./layoutKeyframeGroup";
import {
  DEFAULT_SECTION_PREFIX,
  DYNAMIC_SECTION_PREFIX,
  getDefaultSectionId,
  getDynamicSectionId,
} from "./sectionIds";

export { getDefaultSectionId, getDynamicSectionId };

const LAYOUT_MARKER_EPSILON_TICKS = 1;

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
  isLayoutTrack: boolean;
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
  /** One marker for the shared position/scale/rotation keyframe track; its
   *  `transformId` is one of the three, edits must go through the track. */
  isLayoutTrack: boolean;
}

/**
 * Colour index for the group at `groupIndex` in a section's flattened group
 * list: position, scale and rotation share the colour of the first of them,
 * since they share one keyframe track.
 */
export function resolveSectionGroupColorIndex(
  groupIds: readonly string[],
  groupIndex: number,
): number {
  if (!isLayoutKeyframeGroupType(groupIds[groupIndex] ?? "")) return groupIndex;
  const firstLayoutIndex = groupIds.findIndex(isLayoutKeyframeGroupType);
  return firstLayoutIndex === -1 ? groupIndex : firstLayoutIndex;
}

export function getSectionGroupKeyframeColor(index: number): string {
  const paletteSize = SECTION_GROUP_KEYFRAME_COLORS.length;
  const normalizedIndex = ((index % paletteSize) + paletteSize) % paletteSize;
  return SECTION_GROUP_KEYFRAME_COLORS[normalizedIndex];
}

/**
 * The definitions a default section renders, in panel order.
 *
 * Sections are not 1:1 with definitions: "Layout" bundles layout with fit mode,
 * "Blend" bundles opacity and blend mode, and "Audio" bundles volume with the
 * audio effects; "default:blend" and "default:audio" name no definition at all.
 * Resolve through the same section models the panel renders from, and fall back
 * to a bare definition type for panels that address a definition's own section
 * directly.
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
  const definitions = resolveSectionDefinitions(sectionType);
  const groupIds = definitions.flatMap((definition) =>
    definition.uiConfig.groups.map((group) => group.id),
  );
  let groupIndex = 0;

  definitions.forEach((definition) => {
    definition.uiConfig.groups.forEach((group) => {
      const currentGroupIndex = resolveSectionGroupColorIndex(groupIds, groupIndex);
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
        isLayoutTrack: isLayoutKeyframeTransform(transform),
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
        isLayoutTrack: false,
      },
    ];
  }

  return entry.uiConfig.groups.map((group, groupIndex) => ({
    groupId: group.id,
    groupIndex,
    transform,
    color: getSectionGroupKeyframeColor(groupIndex),
    isLayoutTrack: false,
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
  // Unaligned keys from older projects still show once per time.
  const layoutTimes: number[] = [];

  return groups
    .flatMap((group) =>
      (group.transform.keyframeTimes ?? []).flatMap((inputTime, markerIndex) => {
        if (group.isLayoutTrack) {
          if (
            layoutTimes.some(
              (time) => Math.abs(time - inputTime) <= LAYOUT_MARKER_EPSILON_TICKS,
            )
          ) {
            return [];
          }
          layoutTimes.push(inputTime);
        }
        return [
          {
            id: `${group.transform.id}:${group.groupId}:${inputTime}:${markerIndex}`,
            groupId: group.groupId,
            groupIndex: group.groupIndex,
            transformId: group.transform.id,
            inputTime,
            visualTime: clipSourceTimeToVisual(clip, inputTime),
            color: group.color,
            isLayoutTrack: group.isLayoutTrack,
          },
        ];
      }),
    )
    .sort((a, b) => {
      if (a.visualTime !== b.visualTime) {
        return a.visualTime - b.visualTime;
      }
      return a.groupIndex - b.groupIndex;
    });
}
