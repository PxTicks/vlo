import type {
  ExtensionPayload,
  ExtensionTimelineTransactionFailureCode,
} from "@vlo/extension-sdk";
import type {
  ClipMask,
  ClipMaskParameters,
  ClipTransform,
  MaskActiveRange,
  MaskTimelineClip,
  TimelineClip,
  TrackType,
  Transition,
} from "../../../types/TimelineTypes";
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
  addTransitionToDraft,
  addClipMaskToDraft,
  finalizeModelDraft,
  insertTrackIntoDraft,
  removeTransitionFromDraft,
  splitClipInDraft,
  updateClipMaskInDraft,
  updateTransitionParametersInDraft,
} from "./timelineCommands";
import {
  getMinimumClipDurationTicks,
  getResizeConstraints,
  resolveCollision,
} from "../utils/collision";
import { getResizedClipLeft, getResizedClipRight } from "../utils/clipMath";
import { useProjectStore } from "../../project";
import { makeMaskClipId } from "./maskClipModel";
import { getExtensionMaskOwnerId } from "./extensionMaskOwnership";
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
    }
  | {
      kind: "create_transition";
      transition: Transition;
    }
  | {
      kind: "update_transition_parameters";
      transitionId: string;
      parameters: Record<string, unknown>;
    }
  | {
      kind: "remove_transition";
      transitionId: string;
    }
  | {
      kind: "add_mask";
      clipId: string;
      mask: ClipMask;
      name?: string;
    }
  | {
      kind: "update_mask_parameters";
      clipId: string;
      maskId: string;
      parameters: ClipMaskParameters;
    }
  | {
      kind: "set_mask_active_range";
      clipId: string;
      maskId: string;
      range: MaskActiveRange | null;
    }
  | {
      kind: "remove_mask";
      clipId: string;
      maskId: string;
    }
  | {
      // The clip is built by the host from a project asset before it reaches
      // here (resolving assets in this module would close a timeline↔userAssets
      // import cycle). Placement remains this layer's decision.
      kind: "create_clip";
      clip: TimelineClip;
      trackId?: string;
    }
  | {
      kind: "move_clip";
      clipId: string;
      startTicks?: number;
      trackId?: string;
    }
  | {
      kind: "trim_clip";
      clipId: string;
      startTicks?: number;
      endTicks?: number;
    }
  | {
      kind: "split_clip";
      clipId: string;
      atTicks: number;
    }
  | {
      kind: "remove_clip";
      clipId: string;
    }
  | {
      kind: "create_track";
      trackId: string;
      label?: string;
      type?: TrackType;
      index?: number;
    }
  | {
      kind: "update_track";
      trackId: string;
      label?: string;
      isVisible?: boolean;
      isMuted?: boolean;
      isLocked?: boolean;
    }
  | {
      kind: "remove_track";
      trackId: string;
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

/**
 * Structural rules for extension clip/track writes.
 *
 * These call the same pure validators the timeline's own drag and resize
 * interactions use (`resolveCollision`, `getResizeConstraints`,
 * `getMinimumClipDurationTicks`), rather than re-deriving them. The UI keeps
 * its copies for live feedback while a pointer is down; this is the authority
 * for what actually reaches the model, so an extension supplies intent and
 * never correctness. Adding a rule here covers extensions automatically.
 */

/** Rejects the subordinate and owner-checked clip kinds a clip command must not touch. */
function assertOrdinaryClip(
  clip: TimelineClip,
  operation: string,
): void {
  if (clip.type === "mask") {
    throw new ExtensionTimelineCommandError(
      "invalid_command",
      `Clip '${clip.id}' is a mask; use the mask commands instead of ${operation}.`,
    );
  }
  if (isExtensionTimelineClip(clip)) {
    // Entities stay behind their owner check: routing them through the clip
    // commands would let any extension move or delete another's content.
    throw new ExtensionTimelineCommandError(
      "invalid_command",
      `Clip '${clip.id}' is an extension entity; use the entity commands instead of ${operation}.`,
    );
  }
}

function requireTrack(draft: TimelineModelState, trackId: string) {
  const track = draft.tracks.find((candidate) => candidate.id === trackId);
  if (!track) {
    throw new ExtensionTimelineCommandError(
      "track_not_found",
      `Timeline track '${trackId}' was not found.`,
    );
  }
  return track;
}

/**
 * A populated typed track only accepts clips of its own class; an empty track
 * takes the class of whatever lands on it. Mirrors `addClipToDraft`.
 */
function assertTrackAccepts(
  draft: TimelineModelState,
  trackId: string,
  clip: TimelineClip,
): void {
  const track = requireTrack(draft, trackId);
  const clipType = getTrackTypeFromClip(clip);
  const trackHasOtherClips = draft.clips.some(
    (candidate) =>
      candidate.trackId === trackId &&
      candidate.type !== "mask" &&
      candidate.id !== clip.id,
  );
  if (track.type && trackHasOtherClips && track.type !== clipType) {
    throw new ExtensionTimelineCommandError(
      "track_type_mismatch",
      `Timeline track '${trackId}' holds "${track.type}" clips and cannot accept ` +
        `'${clip.id}', which resolves to "${clipType}".`,
    );
  }
}

/**
 * The nearest legal start for a clip on a track, using the host's own overlap
 * resolution. A request that cannot be corrected fails rather than overlapping.
 */
function resolveLegalStart(
  draft: TimelineModelState,
  clip: TimelineClip,
  requestedStart: number,
  trackId: string,
): number {
  const resolved = resolveCollision(
    clip.id,
    Math.max(0, requestedStart),
    clip.timelineDuration,
    trackId,
    draft.clips,
  );
  if (resolved === null) {
    throw new ExtensionTimelineCommandError(
      "no_free_slot",
      `Clip '${clip.id}' has no free position on track '${trackId}'.`,
    );
  }
  return resolved;
}

/** The first track that can accept the clip, preferring the bottom-most. */
function findCompatibleTrackId(
  draft: TimelineModelState,
  clip: TimelineClip,
): string | null {
  const clipType = getTrackTypeFromClip(clip);
  for (let index = draft.tracks.length - 1; index >= 0; index -= 1) {
    const track = draft.tracks[index];
    const trackHasClips = draft.clips.some(
      (candidate) =>
        candidate.trackId === track.id && candidate.type !== "mask",
    );
    if (!track.type || !trackHasClips || track.type === clipType) {
      return track.id;
    }
  }
  return null;
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

  const getOwnedTransition = (transitionId: string) => {
    const transition = draft.transitions.find(
      (candidate) => candidate.id === transitionId,
    );
    if (!transition) {
      throw new ExtensionTimelineCommandError(
        "transition_not_found",
        `Transition '${transitionId}' was not found.`,
      );
    }
    if (!transition.type.startsWith(`${ownerId}/`)) {
      throw new ExtensionTimelineCommandError(
        "wrong_owner",
        `Extension '${ownerId}' cannot mutate transition '${transitionId}'.`,
      );
    }
    return transition;
  };

  const getOwnedMask = (clipId: string, maskId: string): MaskTimelineClip => {
    const mask = draft.clips.find(
      (candidate): candidate is MaskTimelineClip =>
        candidate.id === makeMaskClipId(clipId, maskId) &&
        candidate.type === "mask",
    );
    if (!mask) {
      throw new ExtensionTimelineCommandError(
        "mask_not_found",
        `Mask '${maskId}' was not found on clip '${clipId}'.`,
      );
    }
    if (getExtensionMaskOwnerId(maskId) !== ownerId) {
      throw new ExtensionTimelineCommandError(
        "wrong_owner",
        `Extension '${ownerId}' cannot mutate mask '${maskId}'.`,
      );
    }
    return mask;
  };

  for (const command of commands) {
    if (command.kind === "add_mask") {
      getClip(command.clipId);
      if (getExtensionMaskOwnerId(command.mask.id) !== ownerId) {
        throw new ExtensionTimelineCommandError(
          "wrong_owner",
          `Extension '${ownerId}' cannot create mask '${command.mask.id}'.`,
        );
      }
      addClipMaskToDraft(draft, command.clipId, structuredClone(command.mask));
      const created = draft.clips.find(
        (clip) => clip.id === makeMaskClipId(command.clipId, command.mask.id),
      );
      if (!created) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Mask '${command.mask.id}' could not be added to clip '${command.clipId}'.`,
        );
      }
      if (command.name) created.name = command.name;
      continue;
    }

    if (command.kind === "update_mask_parameters") {
      getOwnedMask(command.clipId, command.maskId);
      updateClipMaskInDraft(draft, command.clipId, command.maskId, {
        maskParameters: structuredClone(command.parameters),
      });
      continue;
    }

    if (command.kind === "set_mask_active_range") {
      getOwnedMask(command.clipId, command.maskId);
      updateClipMaskInDraft(draft, command.clipId, command.maskId, {
        activeRange: command.range ? structuredClone(command.range) : null,
      });
      continue;
    }

    if (command.kind === "remove_mask") {
      const mask = getOwnedMask(command.clipId, command.maskId);
      const removal = planTimelineRemoval(draft.clips, [mask.id]);
      removeClipIdsFromDraft(draft, removal.clipIdsToRemove);
      continue;
    }

    if (command.kind === "create_transition") {
      if (!command.transition.type.startsWith(`${ownerId}/`)) {
        throw new ExtensionTimelineCommandError(
          "wrong_owner",
          `Extension '${ownerId}' cannot create transition type '${command.transition.type}'.`,
        );
      }
      if (!addTransitionToDraft(draft, command.transition)) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Transition '${command.transition.id}' could not be added.`,
        );
      }
      continue;
    }

    if (command.kind === "update_transition_parameters") {
      getOwnedTransition(command.transitionId);
      updateTransitionParametersInDraft(
        draft,
        command.transitionId,
        command.parameters,
      );
      continue;
    }

    if (command.kind === "remove_transition") {
      getOwnedTransition(command.transitionId);
      removeTransitionFromDraft(draft, command.transitionId);
      continue;
    }

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

    if (command.kind === "create_clip") {
      const candidate = structuredClone(command.clip);
      const trackId =
        command.trackId ?? findCompatibleTrackId(draft, candidate);
      if (trackId === null) {
        // Nothing existing can hold this media class; give it its own track
        // rather than failing a legitimate placement.
        const newTrack = createNewTrack(
          candidate.name,
          getTrackTypeFromClip(candidate),
        );
        draft.tracks.push(newTrack);
        candidate.trackId = newTrack.id;
      } else {
        assertTrackAccepts(draft, trackId, candidate);
        candidate.trackId = trackId;
      }

      candidate.start = resolveLegalStart(
        draft,
        candidate,
        candidate.start,
        candidate.trackId,
      );
      addClipToDraft(draft, candidate);
      if (!draft.clips.some((clip) => clip.id === candidate.id)) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Clip '${candidate.id}' could not be placed on track '${candidate.trackId}'.`,
        );
      }
      continue;
    }

    if (command.kind === "move_clip") {
      const clip = getClip(command.clipId);
      assertOrdinaryClip(clip, "moveClip");
      const targetTrackId = command.trackId ?? clip.trackId;
      assertTrackAccepts(draft, targetTrackId, clip);
      const start = resolveLegalStart(
        draft,
        clip,
        command.startTicks ?? clip.start,
        targetTrackId,
      );
      moveClipsInDraft(draft, [
        { clipId: clip.id, start, trackId: targetTrackId },
      ]);
      continue;
    }

    if (command.kind === "trim_clip") {
      const clip = getClip(command.clipId);
      assertOrdinaryClip(clip, "trimClip");
      const minDuration = getMinimumClipDurationTicks(
        useProjectStore.getState().config.fps,
      );

      // Each edge is clamped by the host's own resize constraints: the source
      // media's bounds, the neighbouring clips, and the minimum duration.
      if (command.startTicks !== undefined) {
        const bounds = getResizeConstraints(
          clip,
          draft.clips,
          "left",
          minDuration,
        );
        if (bounds.min > bounds.max) {
          throw new ExtensionTimelineCommandError(
            "no_free_slot",
            `Clip '${clip.id}' cannot be trimmed from the left.`,
          );
        }
        const nextStart = Math.round(
          Math.min(Math.max(command.startTicks, bounds.min), bounds.max),
        );
        const delta = nextStart - clip.start;
        if (delta !== 0) Object.assign(clip, getResizedClipLeft(clip, delta));
      }

      if (command.endTicks !== undefined) {
        const bounds = getResizeConstraints(
          clip,
          draft.clips,
          "right",
          minDuration,
        );
        if (bounds.min > bounds.max) {
          throw new ExtensionTimelineCommandError(
            "no_free_slot",
            `Clip '${clip.id}' cannot be trimmed from the right.`,
          );
        }
        const nextEnd = Math.round(
          Math.min(Math.max(command.endTicks, bounds.min), bounds.max),
        );
        const delta = nextEnd - (clip.start + clip.timelineDuration);
        if (delta !== 0) Object.assign(clip, getResizedClipRight(clip, delta));
      }

      finalizeModelDraft(draft);
      continue;
    }

    if (command.kind === "split_clip") {
      const clip = getClip(command.clipId);
      assertOrdinaryClip(clip, "splitClip");
      // splitClipInDraft owns the bounds check, the source-time split, and the
      // mask/transition consequences.
      const created = splitClipInDraft(
        draft,
        clip.id,
        Math.round(command.atTicks),
      );
      if (created === null) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Split tick ${command.atTicks} is not strictly inside clip '${clip.id}'.`,
        );
      }
      continue;
    }

    if (command.kind === "remove_clip") {
      const clip = getClip(command.clipId);
      assertOrdinaryClip(clip, "removeClip");
      const removal = planTimelineRemoval(draft.clips, [clip.id]);
      removeClipIdsFromDraft(draft, removal.clipIdsToRemove);
      continue;
    }

    if (command.kind === "create_track") {
      if (draft.tracks.some((track) => track.id === command.trackId)) {
        throw new ExtensionTimelineCommandError(
          "invalid_command",
          `Timeline track '${command.trackId}' already exists.`,
        );
      }
      const track = {
        ...createNewTrack(
          command.label ?? `Track ${draft.tracks.length + 1}`,
          command.type,
        ),
        id: command.trackId,
      };
      insertTrackIntoDraft(
        draft,
        command.index ?? draft.tracks.length,
        track,
      );
      continue;
    }

    if (command.kind === "update_track") {
      const track = requireTrack(draft, command.trackId);
      if (command.label !== undefined) track.label = command.label;
      if (command.isVisible !== undefined) track.isVisible = command.isVisible;
      if (command.isMuted !== undefined) track.isMuted = command.isMuted;
      if (command.isLocked !== undefined) track.isLocked = command.isLocked;
      continue;
    }

    if (command.kind === "remove_track") {
      requireTrack(draft, command.trackId);
      const occupant = draft.clips.find(
        (clip) => clip.trackId === command.trackId && clip.type !== "mask",
      );
      if (occupant) {
        // Removing a populated track would delete a user's content as a side
        // effect of a structural edit. Make the extension do it explicitly.
        throw new ExtensionTimelineCommandError(
          "track_not_empty",
          `Timeline track '${command.trackId}' still holds clip '${occupant.id}'.`,
        );
      }
      draft.tracks = draft.tracks.filter(
        (track) => track.id !== command.trackId,
      );
      finalizeModelDraft(draft);
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
