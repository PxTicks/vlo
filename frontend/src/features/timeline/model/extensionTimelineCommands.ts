import type {
  ExtensionPayload,
  ExtensionTimelineTransactionFailureCode,
} from "@vlo/extension-sdk";
import type { ClipTransform } from "../../../types/TimelineTypes";
import {
  isExtensionTimelineClip,
  type ExtensionTimelineClip,
} from "../../../types/TimelineTypes";
import { getTrackTypeFromClip } from "../utils/formatting";
import {
  moveClipsInDraft,
  addClipToDraft,
  planTimelineRemoval,
  removeClipIdsFromDraft,
} from "./timelineCommands";
import {
  createNewTrack,
  type TimelineModelState,
} from "./timelineTrackModel";

export type ExtensionTimelineCommand =
  | {
      kind: "create_entity";
      entityId: string;
      name: string;
      trackId?: string;
      startTicks: number;
      durationTicks: number;
      payload: ExtensionPayload;
    }
  | {
      kind: "update_payload";
      entityId: string;
      payload: ExtensionPayload;
    }
  | {
      kind: "move_entity";
      entityId: string;
      startTicks?: number;
      trackId?: string;
    }
  | {
      kind: "remove_entity";
      entityId: string;
    }
  | {
      kind: "upsert_transform";
      clipId: string;
      transform: ClipTransform;
    }
  | {
      kind: "remove_transform";
      clipId: string;
      transformId: string;
    };

export class ExtensionTimelineCommandError extends Error {
  readonly code: ExtensionTimelineTransactionFailureCode;

  constructor(
    code: ExtensionTimelineTransactionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionTimelineCommandError";
    this.code = code;
  }
}

const DEFAULT_TRANSFORM_ORDER = [
  "position",
  "scale",
  "rotation",
  "fitMode",
  "blendMode",
  "speed",
  "volume",
];

function getDefaultTransformOrder(type: string): number {
  return DEFAULT_TRANSFORM_ORDER.indexOf(type);
}

function insertTransformInDefaultOrder(
  transforms: ClipTransform[],
  transform: ClipTransform,
): void {
  const order = getDefaultTransformOrder(transform.type);
  if (order < 0) {
    transforms.push(transform);
    return;
  }

  const insertionIndex = transforms.findIndex((candidate) => {
    const candidateOrder = getDefaultTransformOrder(candidate.type);
    return candidateOrder < 0 || candidateOrder > order;
  });
  if (insertionIndex < 0) transforms.push(transform);
  else transforms.splice(insertionIndex, 0, transform);
}

export function applyExtensionTimelineCommands(
  draft: TimelineModelState,
  ownerId: string,
  commands: readonly ExtensionTimelineCommand[],
): void {
  const getOwnedEntity = (entityId: string) => {
    const entity = draft.clips.find((clip) => clip.id === entityId);
    if (!entity || !isExtensionTimelineClip(entity)) {
      throw new ExtensionTimelineCommandError(
        "entity_not_found",
        `Extension timeline entity '${entityId}' was not found.`,
      );
    }
    if (entity.extensionPayload.extensionId !== ownerId) {
      throw new ExtensionTimelineCommandError(
        "wrong_owner",
        `Extension '${ownerId}' cannot mutate entity '${entityId}' owned by '${entity.extensionPayload.extensionId}'.`,
      );
    }
    return entity;
  };

  const getClip = (clipId: string) => {
    const clip = draft.clips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      throw new ExtensionTimelineCommandError(
        "clip_not_found",
        `Timeline clip '${clipId}' was not found.`,
      );
    }
    return clip;
  };

  for (const command of commands) {
    if (command.kind === "upsert_transform") {
      const clip = getClip(command.clipId);
      const transform = structuredClone(command.transform);
      const existingIndex = clip.transformations.findIndex(
        (candidate) => candidate.id === transform.id,
      );
      if (existingIndex >= 0) clip.transformations[existingIndex] = transform;
      else insertTransformInDefaultOrder(clip.transformations, transform);
      continue;
    }

    if (command.kind === "remove_transform") {
      const clip = getClip(command.clipId);
      const existingIndex = clip.transformations.findIndex(
        (candidate) => candidate.id === command.transformId,
      );
      if (existingIndex < 0) {
        throw new ExtensionTimelineCommandError(
          "transform_not_found",
          `Transform '${command.transformId}' was not found on clip '${clip.id}'.`,
        );
      }
      clip.transformations.splice(existingIndex, 1);
      continue;
    }

    if (command.kind === "create_entity") {
      if (draft.clips.some((clip) => clip.id === command.entityId)) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Timeline entity '${command.entityId}' already exists.`,
        );
      }
      if (command.payload.extensionId !== ownerId) {
        throw new ExtensionTimelineCommandError(
          "wrong_owner",
          `Extension '${ownerId}' cannot create an entity owned by '${command.payload.extensionId}'.`,
        );
      }

      let targetTrack = command.trackId
        ? draft.tracks.find((track) => track.id === command.trackId)
        : draft.tracks.find((track) => {
            const hasContent = draft.clips.some(
              (clip) => clip.type !== "mask" && clip.trackId === track.id,
            );
            return !hasContent && (!track.type || track.type === "visual");
          });
      if (command.trackId && !targetTrack) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Timeline track '${command.trackId}' was not found.`,
        );
      }
      if (!targetTrack) {
        targetTrack = createNewTrack("Extension", "visual");
        draft.tracks.push(targetTrack);
      }

      const targetHasOtherClips = draft.clips.some(
        (clip) => clip.type !== "mask" && clip.trackId === targetTrack.id,
      );
      const targetHasIncompatibleClip = draft.clips.some(
        (clip) =>
          clip.type !== "mask" &&
          clip.trackId === targetTrack.id &&
          getTrackTypeFromClip(clip) !== "visual",
      );
      if (
        targetHasOtherClips &&
        ((targetTrack.type !== undefined && targetTrack.type !== "visual") ||
          targetHasIncompatibleClip)
      ) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Timeline track '${targetTrack.id}' cannot contain an extension entity.`,
        );
      }

      const entity: ExtensionTimelineClip = {
        id: command.entityId,
        trackId: targetTrack.id,
        type: "extension",
        name: command.name,
        sourceDuration: null,
        start: command.startTicks,
        timelineDuration: command.durationTicks,
        offset: 0,
        transformedDuration: command.durationTicks,
        transformedOffset: 0,
        croppedSourceDuration: command.durationTicks,
        transformations: [],
        extensionPayload: structuredClone(command.payload),
      };
      addClipToDraft(draft, entity);
      if (!draft.clips.some((clip) => clip.id === entity.id)) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Timeline entity '${entity.id}' could not be added.`,
        );
      }
      continue;
    }

    const entity = getOwnedEntity(command.entityId);
    if (command.kind === "update_payload") {
      if (
        command.payload.extensionId !== ownerId ||
        command.payload.typeId !== entity.extensionPayload.typeId
      ) {
        throw new ExtensionTimelineCommandError(
          "incompatible_payload",
          `Updated payload for '${entity.id}' must retain provider '${ownerId}/${entity.extensionPayload.typeId}'.`,
        );
      }
      entity.extensionPayload = structuredClone(command.payload);
      continue;
    }

    if (command.kind === "move_entity") {
      const targetTrackId = command.trackId ?? entity.trackId;
      const targetTrack = draft.tracks.find(
        (track) => track.id === targetTrackId,
      );
      if (!targetTrack) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Timeline track '${targetTrackId}' was not found.`,
        );
      }
      const targetHasOtherClips = draft.clips.some(
        (clip) =>
          clip.id !== entity.id &&
          clip.type !== "mask" &&
          clip.trackId === targetTrackId,
      );
      if (
        targetTrack.type &&
        targetHasOtherClips &&
        targetTrack.type !== getTrackTypeFromClip(entity)
      ) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Timeline track '${targetTrackId}' is not compatible with entity '${entity.id}'.`,
        );
      }
      moveClipsInDraft(draft, [
        {
          clipId: entity.id,
          start: command.startTicks ?? entity.start,
          trackId: targetTrackId,
        },
      ]);
      continue;
    }

    const removalPlan = planTimelineRemoval(draft.clips, [entity.id]);
    removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
  }
}
