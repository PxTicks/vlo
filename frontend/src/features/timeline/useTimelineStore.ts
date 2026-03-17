// hooks/useTimelineStore.ts
import {
  applyPatches,
  enablePatches,
  produceWithPatches,
  type Patch,
} from "../../lib/immerLite";
import { create } from "zustand";
import type {
  ClipTransform,
  ClipMask,
  ClipMaskType,
  ClipMaskMode,
  ClipMaskParameters,
  ClipMaskPoint,
  TimelineClip,
  TimelineTrack,
  MaskTimelineClip,
  StandardTimelineClip,
  TimelineClipComponentRef,
} from "../../types/TimelineTypes";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import { fileSystemService } from "../project/services/FileSystemService";
import { projectDocumentService } from "../project/services/ProjectDocumentService";
import { TICKS_PER_SECOND } from "./constants";
import { getTrackTypeFromClipType } from "./utils/formatting";
import { getResizedClipLeft, getResizedClipRight } from "./utils/clipMath";
import { resolveCollision } from "./utils/collision";

enablePatches();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASK_CONTEXT_SEPARATOR = "::mask::";
const INHERITED_TRANSFORM_TYPES = new Set(["speed"]);
const TIMELINE_HISTORY_LIMIT = 100;
const TIMELINE_PERSIST_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Timeline model helpers
// ---------------------------------------------------------------------------

interface TimelineModelState {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

interface TimelineHistoryEntry {
  forwardPatches: Patch[];
  inversePatches: Patch[];
}

const generateTrackId = () => `track_${crypto.randomUUID()}`;

const createNewTrack = (label: string): TimelineTrack => ({
  id: generateTrackId(),
  label,
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

const createDefaultTimelineSnapshot = (): TimelineSnapshot => ({
  tracks: [createNewTrack("Track 1")],
  clips: [],
});

const cloneTimelineClip = (
  clip: TimelineClip,
  id: string = clip.id,
): TimelineClip => ({
  ...clip,
  id,
  transformations: structuredClone(clip.transformations || []),
});

function getCurrentModelState(state: TimelineState): TimelineModelState {
  return {
    tracks: state.tracks,
    clips: state.clips,
  };
}

function sanitizeSelectedClipIds(
  selectedClipIds: string[],
  clips: TimelineClip[],
): string[] {
  if (selectedClipIds.length === 0) return selectedClipIds;
  const clipIds = new Set(clips.map((clip) => clip.id));
  return selectedClipIds.filter((id) => clipIds.has(id));
}

function maybeTrimAndPadTracks(model: TimelineModelState): void {
  const { tracks, clips } = model;

  const hasClips = (trackId: string) =>
    clips.some((clip) => clip.trackId === trackId && clip.type !== "mask");

  const populatedIndices = tracks
    .map((track, index) => (hasClips(track.id) ? index : -1))
    .filter((index) => index !== -1);

  if (populatedIndices.length === 0) {
    if (tracks.length === 1 && !hasClips(tracks[0].id)) return;
    model.tracks = [createNewTrack("Track 1")];
    return;
  }

  const firstIndex = populatedIndices[0];
  const lastIndex = populatedIndices[populatedIndices.length - 1];

  const coreTracks = tracks
    .slice(firstIndex, lastIndex + 1)
    .filter((track) => hasClips(track.id));

  const topPadding =
    firstIndex > 0 ? tracks[firstIndex - 1] : createNewTrack("Track Top");
  const bottomPadding =
    lastIndex < tracks.length - 1
      ? tracks[lastIndex + 1]
      : createNewTrack("Track Bottom");

  const newTracks = [topPadding, ...coreTracks, bottomPadding].map((track, i) => ({
    ...track,
    label: `Track ${i + 1}`,
  }));

  const currentIds = tracks.map((track) => track.id).join(",");
  const nextIds = newTracks.map((track) => track.id).join(",");

  if (currentIds === nextIds) return;

  model.tracks = newTracks;
}

// ---------------------------------------------------------------------------
// Mask-as-clip helpers
// ---------------------------------------------------------------------------

/** Read clip component references from a clip (only standard clips carry them). */
function getClipComponents(clip: TimelineClip): TimelineClipComponentRef[] {
  return clip.type !== "mask"
    ? ((clip as StandardTimelineClip).clipComponents ?? [])
    : [];
}

/** Mutably set clip component references on a standard clip. */
function setClipComponents(
  clip: TimelineClip,
  components: TimelineClipComponentRef[],
): void {
  if (clip.type !== "mask") {
    (clip as StandardTimelineClip).clipComponents = components;
  }
}

function getChildMaskClipIds(clip: TimelineClip): string[] {
  return getClipComponents(clip)
    .filter((component) => component.componentType === "mask")
    .map((component) => component.clipId);
}

function getSam2MaskAssetId(clip: TimelineClip): string | null {
  return clip.type === "mask" ? clip.sam2MaskAssetId ?? null : null;
}

export function countSam2MaskAssetConsumers(
  clips: readonly TimelineClip[],
  assetId: string | null | undefined,
): number {
  if (!assetId) {
    return 0;
  }

  return clips.reduce((count, clip) => {
    return count + (getSam2MaskAssetId(clip) === assetId ? 1 : 0);
  }, 0);
}

/** Replace mask component refs while preserving non-mask component refs. */
function setChildMaskClipIds(clip: TimelineClip, maskClipIds: string[]): void {
  if (clip.type === "mask") return;
  const existing = getClipComponents(clip);
  const nonMask = existing.filter((component) => component.componentType !== "mask");
  const uniqueMaskIds = [...new Set(maskClipIds)];
  const maskComponents = uniqueMaskIds.map(
    (clipId): TimelineClipComponentRef => ({
      clipId,
      componentType: "mask",
    }),
  );
  setClipComponents(clip, [...nonMask, ...maskComponents]);
}

function addMaskClipComponent(clip: TimelineClip, maskClipId: string): void {
  const currentMaskIds = getChildMaskClipIds(clip);
  if (currentMaskIds.includes(maskClipId)) return;
  setChildMaskClipIds(clip, [...currentMaskIds, maskClipId]);
}

function removeMaskClipComponent(clip: TimelineClip, maskClipId: string): void {
  const currentMaskIds = getChildMaskClipIds(clip);
  setChildMaskClipIds(
    clip,
    currentMaskIds.filter((id) => id !== maskClipId),
  );
}

function makeMaskClipId(parentClipId: string, maskLocalId: string): string {
  return `${parentClipId}${MASK_CONTEXT_SEPARATOR}${maskLocalId}`;
}

/** Extract { clipId, maskId } from a mask clip's id, or null if not a mask id. */
export function parseMaskClipId(
  id: string,
): { clipId: string; maskId: string } | null {
  const idx = id.indexOf(MASK_CONTEXT_SEPARATOR);
  if (idx <= 0) return null;
  const clipId = id.slice(0, idx);
  const maskId = id.slice(idx + MASK_CONTEXT_SEPARATOR.length);
  if (!clipId || !maskId) return null;
  return { clipId, maskId };
}

function getInheritedSpeedTransforms(
  parentClip: TimelineClip,
): ClipTransform[] {
  return (parentClip.transformations || []).filter((transform) =>
    INHERITED_TRANSFORM_TYPES.has(transform.type),
  );
}

function buildMaskClipTransformations(
  maskTransforms: ClipTransform[],
  parentClip: TimelineClip,
): ClipTransform[] {
  const inherited = getInheritedSpeedTransforms(parentClip);
  if (inherited.length === 0) return maskTransforms;
  return [...maskTransforms, ...inherited];
}

/**
 * Create a mask TimelineClip from mask data + parent clip.
 * Timing is copied from the parent; transforms are the mask's own + inherited speed.
 */
function createMaskClip(
  parentClip: TimelineClip,
  opts: {
    maskLocalId?: string;
    maskType: ClipMaskType;
    maskMode: ClipMaskMode;
    maskInverted: boolean;
    maskParameters: ClipMaskParameters;
    maskPoints?: ClipMaskPoint[];
    sam2MaskAssetId?: string;
    sam2GeneratedPointsHash?: string;
    sam2LastGeneratedAt?: number;
    generationMaskAssetId?: string;
    transformations: ClipTransform[];
  },
): TimelineClip {
  const maskLocalId = opts.maskLocalId ?? crypto.randomUUID();
  return {
    id: makeMaskClipId(parentClip.id, maskLocalId),
    trackId: parentClip.trackId,
    type: "mask",
    name: `Mask ${maskLocalId}`,
    assetId: undefined,
    sourceDuration: parentClip.sourceDuration,
    start: parentClip.start,
    timelineDuration: parentClip.timelineDuration,
    offset: parentClip.offset,
    transformedDuration: parentClip.transformedDuration,
    transformedOffset: parentClip.transformedOffset,
    croppedSourceDuration: parentClip.croppedSourceDuration,
    transformations: buildMaskClipTransformations(
      opts.transformations,
      parentClip,
    ),
    parentClipId: parentClip.id,
    maskType: opts.maskType,
    maskMode: opts.maskMode,
    maskInverted: opts.maskInverted,
    maskParameters: opts.maskParameters,
    maskPoints: opts.maskPoints ? structuredClone(opts.maskPoints) : undefined,
    sam2MaskAssetId: opts.sam2MaskAssetId,
    sam2GeneratedPointsHash: opts.sam2GeneratedPointsHash,
    sam2LastGeneratedAt: opts.sam2LastGeneratedAt,
    generationMaskAssetId: opts.generationMaskAssetId,
  };
}

/** Convert a legacy ClipMask into a mask TimelineClip. */
function maskToClip(parentClip: TimelineClip, mask: ClipMask): TimelineClip {
  return createMaskClip(parentClip, {
    maskLocalId: mask.id,
    maskType: mask.type,
    maskMode: mask.mode,
    maskInverted: mask.inverted,
    maskParameters: mask.parameters,
    maskPoints: mask.maskPoints,
    sam2MaskAssetId: mask.sam2MaskAssetId,
    sam2GeneratedPointsHash: mask.sam2GeneratedPointsHash,
    sam2LastGeneratedAt: mask.sam2LastGeneratedAt,
    generationMaskAssetId: mask.generationMaskAssetId,
    transformations: mask.transformations ?? [],
  });
}

/**
 * Sync timing fields from a (potentially updated) parent clip onto a mask clip.
 * Returns a new clip object only if something changed.
 */
function syncMaskTiming(
  maskClip: TimelineClip,
  parent: TimelineClip,
): TimelineClip {
  if (
    maskClip.start === parent.start &&
    maskClip.timelineDuration === parent.timelineDuration &&
    maskClip.offset === parent.offset &&
    maskClip.sourceDuration === parent.sourceDuration &&
    maskClip.transformedDuration === parent.transformedDuration &&
    maskClip.transformedOffset === parent.transformedOffset &&
    maskClip.croppedSourceDuration === parent.croppedSourceDuration &&
    maskClip.trackId === parent.trackId
  ) {
    return maskClip;
  }

  return {
    ...maskClip,
    start: parent.start,
    timelineDuration: parent.timelineDuration,
    offset: parent.offset,
    sourceDuration: parent.sourceDuration,
    transformedDuration: parent.transformedDuration,
    transformedOffset: parent.transformedOffset,
    croppedSourceDuration: parent.croppedSourceDuration,
    trackId: parent.trackId,
  };
}

/** Strip inherited speed transforms, leaving only mask-local transforms. */
function getMaskLocalTransforms(maskClip: TimelineClip): ClipTransform[] {
  return (maskClip.transformations || []).filter(
    (transform) => !INHERITED_TRANSFORM_TYPES.has(transform.type),
  );
}

/**
 * Update inherited speed transforms on a mask clip to match a new parent.
 * Only produces a new object when the speed transforms actually differ.
 */
function syncMaskInheritedSpeed(
  maskClip: TimelineClip,
  parentClip: TimelineClip,
): TimelineClip {
  const localTransforms = getMaskLocalTransforms(maskClip);
  const parentSpeed = getInheritedSpeedTransforms(parentClip);

  const merged =
    parentSpeed.length > 0
      ? [...localTransforms, ...parentSpeed]
      : localTransforms;

  if (
    merged.length === maskClip.transformations.length &&
    parentSpeed.every(
      (transform, i) =>
        maskClip.transformations[localTransforms.length + i] === transform,
    )
  ) {
    return maskClip;
  }

  return { ...maskClip, transformations: merged };
}

/**
 * After a parent clip is updated, propagate timing + speed transforms to all its mask clips.
 * Returns the full clips array with mask clips updated in-place.
 */
function propagateParentToMasks(
  clips: TimelineClip[],
  parentClip: TimelineClip,
): TimelineClip[] {
  const maskChildIds = new Set(getChildMaskClipIds(parentClip));
  if (maskChildIds.size === 0) return clips;

  return clips.map((clip) => {
    if (!maskChildIds.has(clip.id)) return clip;
    let updated = syncMaskTiming(clip, parentClip);
    updated = syncMaskInheritedSpeed(updated, parentClip);
    return updated;
  });
}

/**
 * Clone a clip and all its child mask clips.
 * Returns [clonedParent, ...clonedMasks].
 */
function cloneClipWithMasks(
  clip: TimelineClip,
  allClips: TimelineClip[],
  newParentId?: string,
): TimelineClip[] {
  const parentId = newParentId ?? crypto.randomUUID();
  const clonedParent = cloneTimelineClip(clip, parentId);

  const maskChildIds = getChildMaskClipIds(clip);
  const maskChildIdSet = new Set(maskChildIds);
  const childMasks = maskChildIds.length > 0
    ? allClips.filter((c) => maskChildIdSet.has(c.id) && c.type === "mask")
    : [];

  const clonedMaskIds: string[] = [];
  const clonedMasks = childMasks.map((maskClip) => {
    const parsed = parseMaskClipId(maskClip.id);
    const maskLocalId = parsed?.maskId ?? crypto.randomUUID();
    const newMaskId = makeMaskClipId(parentId, maskLocalId);
    clonedMaskIds.push(newMaskId);

    const clonedMask = {
      ...cloneTimelineClip(maskClip, newMaskId),
      parentClipId: parentId,
      trackId: clonedParent.trackId,
    };

    return syncMaskInheritedSpeed(
      syncMaskTiming(clonedMask, clonedParent),
      clonedParent,
    );
  });

  setChildMaskClipIds(clonedParent, clonedMaskIds);

  return [clonedParent, ...clonedMasks];
}

function collectClipRemovalPlan(
  clips: TimelineClip[],
  clipIds: Iterable<string>,
): {
  clipIdsToRemove: Set<string>;
  sam2MaskAssetIdsToDelete: Set<string>;
} {
  const clipIdsToRemove = new Set<string>();
  const sam2MaskAssetIdsToDelete = new Set<string>();
  const clipById = new Map(clips.map((clip) => [clip.id, clip]));

  for (const clipId of clipIds) {
    const clip = clipById.get(clipId);
    if (!clip) {
      continue;
    }

    clipIdsToRemove.add(clip.id);

    if (clip.type === "mask") {
      const sam2MaskAssetId = getSam2MaskAssetId(clip);
      if (sam2MaskAssetId) {
        sam2MaskAssetIdsToDelete.add(sam2MaskAssetId);
      }
      continue;
    }

    for (const maskChildId of getChildMaskClipIds(clip)) {
      clipIdsToRemove.add(maskChildId);
      const maskClip = clipById.get(maskChildId);
      const sam2MaskAssetId = maskClip ? getSam2MaskAssetId(maskClip) : null;
      if (sam2MaskAssetId) {
        sam2MaskAssetIdsToDelete.add(sam2MaskAssetId);
      }
    }
  }

  for (const assetId of [...sam2MaskAssetIdsToDelete]) {
    const hasRemainingConsumer = clips.some((clip) => {
      if (clipIdsToRemove.has(clip.id)) {
        return false;
      }

      return getSam2MaskAssetId(clip) === assetId;
    });

    if (hasRemainingConsumer) {
      sam2MaskAssetIdsToDelete.delete(assetId);
    }
  }

  return {
    clipIdsToRemove,
    sam2MaskAssetIdsToDelete,
  };
}

function removeClipsFromDraft(
  draft: TimelineModelState,
  clipIdsToRemove: Set<string>,
): void {
  if (clipIdsToRemove.size === 0) {
    return;
  }

  const removedClips = draft.clips.filter((clip) => clipIdsToRemove.has(clip.id));
  if (removedClips.length === 0) {
    return;
  }
  const affectedTrackIds = new Set(removedClips.map((clip) => clip.trackId));

  draft.clips = draft.clips.filter((clip) => !clipIdsToRemove.has(clip.id));

  for (const removedClip of removedClips) {
    if (removedClip.type !== "mask") {
      continue;
    }

    const parsed = parseMaskClipId(removedClip.id);
    if (!parsed) {
      continue;
    }

    const parent = draft.clips.find((candidate) => candidate.id === parsed.clipId);
    if (parent) {
      removeMaskClipComponent(parent, removedClip.id);
    }
  }

  draft.tracks = draft.tracks.map((track) => {
    if (!affectedTrackIds.has(track.id)) {
      return track;
    }

    const hasNonMaskClips = draft.clips.some(
      (clip) => clip.trackId === track.id && clip.type !== "mask",
    );
    return hasNonMaskClips ? track : { ...track, type: undefined };
  });

  maybeTrimAndPadTracks(draft);
}

// ---------------------------------------------------------------------------
// Selector helpers (exported for use in hooks)
// ---------------------------------------------------------------------------

export const selectMaskClipsForParent = (
  state: { clips: TimelineClip[] },
  parentClipId: string,
): MaskTimelineClip[] => {
  const parent = state.clips.find((c) => c.id === parentClipId);
  if (!parent) return [];
  const maskChildIds = getChildMaskClipIds(parent);
  if (maskChildIds.length === 0) return [];
  const maskChildIdSet = new Set(maskChildIds);
  return state.clips.filter(
    (clip) => maskChildIdSet.has(clip.id) && clip.type === "mask",
  ) as MaskTimelineClip[];
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface TimelineState {
  tracks: TimelineTrack[];
  clips: TimelineClip[];

  selectedClipIds: string[];
  copiedClips: TimelineClip[];

  canUndo: boolean;
  canRedo: boolean;

  // ACTIONS
  duplicateClip: (clip: TimelineClip) => TimelineClip;
  copySelectedClip: () => boolean;
  pasteCopiedClipAbove: () => boolean;
  splitClip: (clipId: string, splitTime: number) => void;

  addTrack: () => void;
  insertTrack: (index: number) => string;

  addClip: (clip: TimelineClip) => void;

  removeClip: (id: string) => void;
  removeClipsByAssetId: (assetId: string) => number;

  selectClip: (id: string | null, isMulti?: boolean) => void;

  updateClipPosition: (
    id: string,
    newStartTicks: number,
    newTrackId?: string,
  ) => void;

  updateClipShape: (
    id: string,
    shape: Partial<
      Pick<
        TimelineClip,
        | "start"
        | "timelineDuration"
        | "offset"
        | "transformedDuration"
        | "transformedOffset"
        | "croppedSourceDuration"
      >
    >,
  ) => void;

  updateClipDuration: (id: string, newDurationTicks: number) => void;

  addClipTransform: (clipId: string, effect: ClipTransform) => void;

  updateClipTransform: (
    clipId: string,
    effectId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;

  setClipTransforms: (clipId: string, transforms: ClipTransform[]) => void;

  removeClipTransform: (clipId: string, effectId: string) => void;

  addClipMask: (clipId: string, mask: ClipMask) => void;

  updateClipMask: (
    clipId: string,
    maskId: string,
    updates: Partial<
      Pick<
        MaskTimelineClip,
        | "maskMode"
        | "maskInverted"
        | "maskParameters"
        | "maskPoints"
        | "sam2MaskAssetId"
        | "sam2GeneratedPointsHash"
        | "sam2LastGeneratedAt"
      >
    > & {
      transformations?: ClipTransform[];
    },
  ) => void;

  removeClipMask: (clipId: string, maskId: string) => void;

  toggleTrackVisibility: (trackId: string) => void;
  toggleTrackMute: (trackId: string) => void;
  trimAndPadTracks: () => void;

  undo: () => boolean;
  redo: () => boolean;

  replaceTimelineSnapshot: (snapshot: TimelineSnapshot | null) => void;
  flushPendingPersistence: () => Promise<void>;

  getClipsAtTime: (timeTicks: number) => TimelineClip[];
}

let didRegisterBeforeUnloadListener = false;

export const useTimelineStore = create<TimelineState>((set, get) => {
  let undoStack: TimelineHistoryEntry[] = [];
  let redoStack: TimelineHistoryEntry[] = [];
  let pendingDocumentPatches: Patch[] = [];
  let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInFlight: Promise<void> | null = null;

  const toDocumentTimelinePatches = (timelinePatches: Patch[]): Patch[] => {
    return timelinePatches.map((patch) => ({
      ...patch,
      path: ["timeline", ...patch.path],
    }));
  };

  const queueTimelinePatchesForPersistence = (timelinePatches: Patch[]): void => {
    if (timelinePatches.length === 0) return;
    if (!fileSystemService.getHandle()) return;

    pendingDocumentPatches.push(...toDocumentTimelinePatches(timelinePatches));

    if (pendingPersistTimer !== null) return;

    pendingPersistTimer = setTimeout(() => {
      pendingPersistTimer = null;
      void flushPendingPersistence();
    }, TIMELINE_PERSIST_DEBOUNCE_MS);
  };

  const flushPendingPersistence = async (): Promise<void> => {
    if (pendingPersistTimer !== null) {
      clearTimeout(pendingPersistTimer);
      pendingPersistTimer = null;
    }

    if (flushInFlight) {
      await flushInFlight;
    }

    if (pendingDocumentPatches.length === 0) return;
    if (!fileSystemService.getHandle()) {
      pendingDocumentPatches = [];
      return;
    }

    const patchesToApply = pendingDocumentPatches;
    pendingDocumentPatches = [];

    const fallbackSnapshot: TimelineSnapshot = {
      tracks: structuredClone(get().tracks),
      clips: structuredClone(get().clips),
    };

    flushInFlight = projectDocumentService
      .applyProjectDocumentPatches(patchesToApply, (draft) => {
        draft.timeline = structuredClone(fallbackSnapshot);
      })
      .then(() => undefined)
      .catch(async (error) => {
        console.error(
          "[TimelineStore] Failed to apply timeline patches; writing snapshot fallback.",
          error,
        );

        await projectDocumentService.updateProjectDocument((draft) => {
          draft.timeline = structuredClone(fallbackSnapshot);
        });
      })
      .finally(() => {
        flushInFlight = null;
      });

    await flushInFlight;

    if (pendingDocumentPatches.length > 0) {
      await flushPendingPersistence();
    }
  };

  const applyHistoryFlags = () => ({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });

  const commitModelMutation = (
    recipe: (draft: TimelineModelState) => void,
    opts?: { persist?: boolean; recordHistory?: boolean },
  ): boolean => {
    const { persist = true, recordHistory = true } = opts ?? {};

    const currentModel = getCurrentModelState(get());
    const [nextModel, forwardPatches, inversePatches] = produceWithPatches(
      currentModel,
      recipe,
    );

    if (forwardPatches.length === 0) return false;

    if (recordHistory) {
      undoStack.push({ forwardPatches, inversePatches });
      if (undoStack.length > TIMELINE_HISTORY_LIMIT) {
        undoStack.shift();
      }
      redoStack = [];
    }

    set((state) => ({
      tracks: nextModel.tracks,
      clips: nextModel.clips,
      selectedClipIds: sanitizeSelectedClipIds(
        state.selectedClipIds,
        nextModel.clips,
      ),
      ...applyHistoryFlags(),
    }));

    if (persist) {
      queueTimelinePatchesForPersistence(forwardPatches);
    }

    return true;
  };

  const deleteSam2MaskAssets = (assetIds: Iterable<string>): void => {
    const uniqueAssetIds = [...new Set([...assetIds].filter(Boolean))];
    if (uniqueAssetIds.length === 0) return;

    void import("../userAssets")
      .then(async ({ deleteAsset }) => {
        for (const assetId of uniqueAssetIds) {
          try {
            await deleteAsset(assetId);
          } catch (error) {
            console.warn(
              `[TimelineStore] Failed to delete SAM2 mask asset '${assetId}'`,
              error,
            );
          }
        }
      })
      .catch((error) => {
        console.warn(
          "[TimelineStore] Failed to load asset store for SAM2 mask cleanup",
          error,
        );
      });
  };

  const replaceTimelineSnapshot = (snapshot: TimelineSnapshot | null) => {
    if (pendingPersistTimer !== null) {
      clearTimeout(pendingPersistTimer);
      pendingPersistTimer = null;
    }
    pendingDocumentPatches = [];
    undoStack = [];
    redoStack = [];

    const next = snapshot
      ? {
          tracks: structuredClone(snapshot.tracks),
          clips: structuredClone(snapshot.clips),
        }
      : createDefaultTimelineSnapshot();

    set({
      tracks: next.tracks,
      clips: next.clips,
      selectedClipIds: [],
      copiedClips: [],
      canUndo: false,
      canRedo: false,
    });
  };

  if (typeof window !== "undefined" && !didRegisterBeforeUnloadListener) {
    window.addEventListener("beforeunload", () => {
      void flushPendingPersistence();
    });
    didRegisterBeforeUnloadListener = true;
  }

  const initial = createDefaultTimelineSnapshot();

  return {
    tracks: initial.tracks,
    clips: initial.clips,
    selectedClipIds: [],
    copiedClips: [],
    canUndo: false,
    canRedo: false,

    addTrack: () => {
      commitModelMutation((draft) => {
        draft.tracks.push(createNewTrack(`Track ${draft.tracks.length + 1}`));
      });
    },

    insertTrack: (index) => {
      const newTrack = createNewTrack("New Track");
      commitModelMutation((draft) => {
        const safeIndex = Math.max(0, Math.min(index, draft.tracks.length));
        draft.tracks.splice(safeIndex, 0, newTrack);
      });
      return newTrack.id;
    },

    addClip: (clip) => {
      commitModelMutation((draft) => {
        const targetTrack = draft.tracks.find((track) => track.id === clip.trackId);
        if (targetTrack && !targetTrack.type) {
          targetTrack.type = getTrackTypeFromClipType(clip.type);
        }

        draft.clips.push(clip);
        maybeTrimAndPadTracks(draft);
      });
    },

    duplicateClip: (clip) => {
      const allClips = get().clips;
      const [parent] = cloneClipWithMasks(clip, allClips);
      return parent;
    },

    copySelectedClip: () => {
      const { selectedClipIds, clips, tracks } = get();
      if (selectedClipIds.length === 0) return false;

      const selectedSet = new Set(selectedClipIds);
      const selectedClips = clips.filter(
        (clip) => selectedSet.has(clip.id) && clip.type !== "mask",
      );
      if (selectedClips.length === 0) return false;

      const trackIndexById = new Map(
        tracks.map((track, index) => [track.id, index] as const),
      );

      const orderedSelection = [...selectedClips].sort((a, b) => {
        const trackDelta =
          (trackIndexById.get(a.trackId) ?? Number.MAX_SAFE_INTEGER) -
          (trackIndexById.get(b.trackId) ?? Number.MAX_SAFE_INTEGER);

        if (trackDelta !== 0) return trackDelta;
        if (a.start !== b.start) return a.start - b.start;
        return a.id.localeCompare(b.id);
      });

      const copiedClips: TimelineClip[] = [];
      orderedSelection.forEach((clip) => {
        copiedClips.push(...cloneClipWithMasks(clip, clips));
      });

      set({ copiedClips });
      return true;
    },

    pasteCopiedClipAbove: () => {
      const { copiedClips } = get();

      const parentCopies = copiedClips.filter((clip) => clip.type !== "mask");
      if (parentCopies.length === 0) return false;

      const maskCopiesByParent = new Map<string, TimelineClip[]>();
      parentCopies.forEach((parent) => {
        const maskChildIds = new Set(getChildMaskClipIds(parent));
        if (maskChildIds.size === 0) return;
        const masks = copiedClips.filter((c) => maskChildIds.has(c.id));
        if (masks.length > 0) {
          maskCopiesByParent.set(parent.id, masks);
        }
      });

      const groupsBySourceTrack = new Map<string, TimelineClip[]>();
      parentCopies.forEach((clip) => {
        const group = groupsBySourceTrack.get(clip.trackId) || [];
        group.push(clip);
        groupsBySourceTrack.set(clip.trackId, group);
      });

      const pastedClipIds: string[] = [];

      const didCommit = commitModelMutation((draft) => {
        const initialTrackIndexById = new Map(
          draft.tracks.map((track, index) => [track.id, index] as const),
        );

        const sourceTrackIdsByPriority = [...groupsBySourceTrack.keys()].sort(
          (a, b) =>
            (initialTrackIndexById.get(b) ?? Number.MIN_SAFE_INTEGER) -
            (initialTrackIndexById.get(a) ?? Number.MIN_SAFE_INTEGER),
        );

        sourceTrackIdsByPriority.forEach((sourceTrackId) => {
          const clipsInGroup = groupsBySourceTrack.get(sourceTrackId) || [];
          if (clipsInGroup.length === 0) return;

          const currentTrackIndex = draft.tracks.findIndex(
            (track) => track.id === sourceTrackId,
          );
          if (currentTrackIndex === -1) return;

          const aboveTrack =
            currentTrackIndex > 0 ? draft.tracks[currentTrackIndex - 1] : null;

          const canUseAboveTrack =
            !!aboveTrack &&
            clipsInGroup.every((clip) => {
              if (
                aboveTrack.type &&
                aboveTrack.type !== getTrackTypeFromClipType(clip.type)
              ) {
                return false;
              }

              return (
                resolveCollision(
                  clip.id,
                  clip.start,
                  clip.timelineDuration,
                  aboveTrack.id,
                  draft.clips,
                ) === clip.start
              );
            });

          const targetTrackId =
            canUseAboveTrack && aboveTrack
              ? aboveTrack.id
              : (() => {
                  const inserted = createNewTrack("New Track");
                  draft.tracks.splice(Math.max(currentTrackIndex, 0), 0, inserted);
                  return inserted.id;
                })();

          clipsInGroup.forEach((clip) => {
            const pastedClip = cloneTimelineClip(clip, crypto.randomUUID());
            pastedClip.trackId = targetTrackId;
            pastedClip.start = clip.start;

            const targetTrack = draft.tracks.find(
              (track) => track.id === targetTrackId,
            );
            if (targetTrack && !targetTrack.type) {
              targetTrack.type = getTrackTypeFromClipType(pastedClip.type);
            }

            const pastedMasks = (maskCopiesByParent.get(clip.id) || []).map(
              (maskClip) => {
                const parsed = parseMaskClipId(maskClip.id);
                const maskLocalId = parsed?.maskId ?? crypto.randomUUID();
                const clonedMask = {
                  ...cloneTimelineClip(
                    maskClip,
                    makeMaskClipId(pastedClip.id, maskLocalId),
                  ),
                  parentClipId: pastedClip.id,
                  trackId: pastedClip.trackId,
                };
                return syncMaskInheritedSpeed(
                  syncMaskTiming(clonedMask, pastedClip),
                  pastedClip,
                );
              },
            );

            setChildMaskClipIds(pastedClip, pastedMasks.map((m) => m.id));
            draft.clips.push(pastedClip);
            draft.clips.push(...pastedMasks);
            pastedClipIds.push(pastedClip.id);
          });
        });

        maybeTrimAndPadTracks(draft);
      });

      if (!didCommit || pastedClipIds.length === 0) return false;

      set({ selectedClipIds: pastedClipIds });
      return true;
    },

    splitClip: (clipId, splitTime) => {
      let rightClipId: string | null = null;

      const didCommit = commitModelMutation((draft) => {
        const clip = draft.clips.find((candidate) => candidate.id === clipId);
        if (!clip) return;

        if (
          splitTime <= clip.start ||
          splitTime >= clip.start + clip.timelineDuration
        ) {
          console.warn("[Store] Split time outside clip bounds");
          return;
        }

        const leftDuration = splitTime - clip.start;
        const leftDelta = leftDuration - clip.timelineDuration;
        const leftUpdates = getResizedClipRight(clip, leftDelta);

        const cloned = cloneClipWithMasks(clip, draft.clips);
        const [rightClip, ...rightMasks] = cloned;

        const rightDelta = splitTime - clip.start;
        const rightUpdates = getResizedClipLeft(rightClip, rightDelta);
        Object.assign(rightClip, rightUpdates);
        rightClipId = rightClip.id;

        const leftParent = { ...clip, ...leftUpdates } as TimelineClip;

        let updatedClips: TimelineClip[] = draft.clips.flatMap((candidate) => {
          if (candidate.id === clipId) {
            return [leftParent, rightClip, ...rightMasks];
          }
          return [candidate];
        });

        updatedClips = propagateParentToMasks(updatedClips, leftParent);
        updatedClips = propagateParentToMasks(updatedClips, rightClip);
        draft.clips = updatedClips;

        maybeTrimAndPadTracks(draft);
      });

      if (!didCommit || !rightClipId) return;
      const nextRightClipId = rightClipId;

      set((state) => ({
        selectedClipIds: state.selectedClipIds.map((id) =>
          id === clipId ? nextRightClipId : id,
        ),
      }));
    },

    removeClip: (id) => {
      const currentState = get();
      const { clipIdsToRemove, sam2MaskAssetIdsToDelete } =
        collectClipRemovalPlan(currentState.clips, [id]);

      const didCommit = commitModelMutation((draft) => {
        removeClipsFromDraft(draft, clipIdsToRemove);
      });

      if (didCommit) {
        deleteSam2MaskAssets(sam2MaskAssetIdsToDelete);
      }
    },

    removeClipsByAssetId: (assetId) => {
      const currentState = get();
      const directlyReferencedClipIds = currentState.clips
        .filter((clip) => clip.assetId === assetId)
        .map((clip) => clip.id);

      if (directlyReferencedClipIds.length === 0) {
        return 0;
      }

      const { clipIdsToRemove, sam2MaskAssetIdsToDelete } =
        collectClipRemovalPlan(currentState.clips, directlyReferencedClipIds);

      const didCommit = commitModelMutation((draft) => {
        removeClipsFromDraft(draft, clipIdsToRemove);
      });

      if (didCommit) {
        deleteSam2MaskAssets(sam2MaskAssetIdsToDelete);
      }

      return directlyReferencedClipIds.length;
    },

    selectClip: (id, isMulti = false) => {
      set((state) => {
        if (id === null) {
          return { selectedClipIds: [] };
        }

        if (isMulti) {
          const isSelected = state.selectedClipIds.includes(id);
          const selectedClipIds = isSelected
            ? state.selectedClipIds.filter((clipId) => clipId !== id)
            : [...state.selectedClipIds, id];

          return { selectedClipIds };
        }

        if (
          state.selectedClipIds.length === 1 &&
          state.selectedClipIds[0] === id
        ) {
          return state;
        }

        return { selectedClipIds: [id] };
      });
    },

    updateClipPosition: (id, newStartTicks, newTrackId) => {
      commitModelMutation((draft) => {
        const clip = draft.clips.find((candidate) => candidate.id === id);
        if (!clip) return;

        if (newTrackId && newTrackId !== clip.trackId) {
          const targetTrack = draft.tracks.find((track) => track.id === newTrackId);
          if (targetTrack && !targetTrack.type) {
            targetTrack.type = getTrackTypeFromClipType(clip.type);
          }

          const isOldTrackEmpty = !draft.clips.some(
            (candidate) =>
              candidate.trackId === clip.trackId &&
              candidate.id !== id &&
              candidate.type !== "mask",
          );

          if (isOldTrackEmpty) {
            draft.tracks = draft.tracks.map((track) =>
              track.id === clip.trackId ? { ...track, type: undefined } : track,
            );
          }
        }

        const updatedParentStart = Math.round(Math.max(0, newStartTicks));
        const updatedTrackId = newTrackId ?? clip.trackId;
        const maskChildIds = new Set(getChildMaskClipIds(clip));

        draft.clips = draft.clips.map((candidate) => {
          if (candidate.id === id || maskChildIds.has(candidate.id)) {
            return {
              ...candidate,
              start: updatedParentStart,
              trackId: updatedTrackId,
            };
          }

          return candidate;
        });

        maybeTrimAndPadTracks(draft);
      });
    },

    updateClipShape: (id, shape) => {
      commitModelMutation((draft) => {
        let updatedParent: TimelineClip | null = null;

        draft.clips = draft.clips.map((clip) => {
          if (clip.id !== id) return clip;

          const updated = {
            ...clip,
            start: shape.start !== undefined ? Math.round(shape.start) : clip.start,
            timelineDuration:
              shape.timelineDuration !== undefined
                ? Math.round(shape.timelineDuration)
                : clip.timelineDuration,
            offset: shape.offset !== undefined ? Math.round(shape.offset) : clip.offset,
            transformedDuration:
              shape.transformedDuration !== undefined
                ? Math.round(shape.transformedDuration)
                : clip.transformedDuration,
            transformedOffset:
              shape.transformedOffset !== undefined
                ? Math.round(shape.transformedOffset)
                : clip.transformedOffset,
            croppedSourceDuration:
              shape.croppedSourceDuration !== undefined
                ? Math.round(shape.croppedSourceDuration)
                : clip.croppedSourceDuration,
          };

          updatedParent = updated;
          return updated;
        });

        if (updatedParent) {
          draft.clips = propagateParentToMasks(draft.clips, updatedParent);
        }
      });
    },

    updateClipDuration: (id, newDurationTicks) => {
      commitModelMutation((draft) => {
        let updatedParent: TimelineClip | null = null;

        draft.clips = draft.clips.map((clip) => {
          if (clip.id !== id) return clip;

          const updated = {
            ...clip,
            timelineDuration: Math.round(
              Math.max(TICKS_PER_SECOND / 60, newDurationTicks),
            ),
          };

          updatedParent = updated;
          return updated;
        });

        if (updatedParent) {
          draft.clips = propagateParentToMasks(draft.clips, updatedParent);
        }
      });
    },

    addClipTransform: (clipId, effect) => {
      commitModelMutation((draft) => {
        draft.clips = draft.clips.map((clip) =>
          clip.id === clipId
            ? { ...clip, transformations: [...(clip.transformations || []), effect] }
            : clip,
        );

        if (INHERITED_TRANSFORM_TYPES.has(effect.type)) {
          const parent = draft.clips.find((clip) => clip.id === clipId);
          if (parent && parent.type !== "mask") {
            draft.clips = propagateParentToMasks(draft.clips, parent);
          }
        }
      });
    },

    updateClipTransform: (clipId, effectId, updates) => {
      commitModelMutation((draft) => {
        draft.clips = draft.clips.map((clip) => {
          if (clip.id !== clipId) return clip;

          return {
            ...clip,
            transformations: clip.transformations.map((effect) =>
              effect.id === effectId ? { ...effect, ...updates } : effect,
            ),
          };
        });

        const parent = draft.clips.find((clip) => clip.id === clipId);
        if (parent && parent.type !== "mask") {
          const transform = parent.transformations.find((t) => t.id === effectId);
          if (transform && INHERITED_TRANSFORM_TYPES.has(transform.type)) {
            draft.clips = propagateParentToMasks(draft.clips, parent);
          }
        }
      });
    },

    setClipTransforms: (clipId, transforms) => {
      commitModelMutation((draft) => {
        draft.clips = draft.clips.map((clip) =>
          clip.id === clipId ? { ...clip, transformations: transforms } : clip,
        );

        const parent = draft.clips.find((clip) => clip.id === clipId);
        if (parent && parent.type !== "mask") {
          draft.clips = propagateParentToMasks(draft.clips, parent);
        }
      });
    },

    removeClipTransform: (clipId, effectId) => {
      commitModelMutation((draft) => {
        const clip = draft.clips.find((candidate) => candidate.id === clipId);
        const removedTransform = clip?.transformations.find(
          (effect) => effect.id === effectId,
        );

        draft.clips = draft.clips.map((candidate) =>
          candidate.id === clipId
            ? {
                ...candidate,
                transformations: candidate.transformations.filter(
                  (effect) => effect.id !== effectId,
                ),
              }
            : candidate,
        );

        if (
          removedTransform &&
          INHERITED_TRANSFORM_TYPES.has(removedTransform.type) &&
          clip &&
          clip.type !== "mask"
        ) {
          const parent = draft.clips.find((candidate) => candidate.id === clipId);
          if (parent) {
            draft.clips = propagateParentToMasks(draft.clips, parent);
          }
        }
      });
    },

    addClipMask: (clipId, mask) => {
      commitModelMutation((draft) => {
        const parent = draft.clips.find((clip) => clip.id === clipId);
        if (!parent) return;

        const maskClip = maskToClip(parent, mask);
        draft.clips.push(maskClip);

        addMaskClipComponent(parent, maskClip.id);
      });
    },

    updateClipMask: (clipId, maskId, updates) => {
      commitModelMutation((draft) => {
        const maskClipId = makeMaskClipId(clipId, maskId);
        const maskClip = draft.clips.find((clip) => clip.id === maskClipId);

        if (!maskClip || maskClip.type !== "mask") return;

        if (updates.maskMode !== undefined) {
          maskClip.maskMode = updates.maskMode;
        }

        if (updates.maskInverted !== undefined) {
          maskClip.maskInverted = updates.maskInverted;
        }

        if (updates.maskParameters !== undefined) {
          maskClip.maskParameters = {
            ...maskClip.maskParameters,
            ...updates.maskParameters,
          };
        }

        if (updates.maskPoints !== undefined) {
          maskClip.maskPoints = structuredClone(updates.maskPoints);
        }

        if (updates.sam2MaskAssetId !== undefined) {
          maskClip.sam2MaskAssetId = updates.sam2MaskAssetId;
        }

        if (updates.sam2GeneratedPointsHash !== undefined) {
          maskClip.sam2GeneratedPointsHash = updates.sam2GeneratedPointsHash;
        }

        if (updates.sam2LastGeneratedAt !== undefined) {
          maskClip.sam2LastGeneratedAt = updates.sam2LastGeneratedAt;
        }

        if (updates.transformations !== undefined) {
          const parent = draft.clips.find((clip) => clip.id === clipId);
          if (parent) {
            maskClip.transformations = buildMaskClipTransformations(
              updates.transformations,
              parent,
            );
          } else {
            maskClip.transformations = updates.transformations;
          }
        }
      });
    },

    removeClipMask: (clipId, maskId) => {
      const maskClipId = makeMaskClipId(clipId, maskId);
      const currentState = get();
      const { clipIdsToRemove, sam2MaskAssetIdsToDelete } =
        collectClipRemovalPlan(currentState.clips, [maskClipId]);

      const didCommit = commitModelMutation((draft) => {
        removeClipsFromDraft(draft, clipIdsToRemove);
      });

      if (didCommit) {
        deleteSam2MaskAssets(sam2MaskAssetIdsToDelete);
      }
    },

    toggleTrackVisibility: (trackId) => {
      commitModelMutation((draft) => {
        draft.tracks = draft.tracks.map((track) =>
          track.id === trackId
            ? { ...track, isVisible: !track.isVisible }
            : track,
        );
      });
    },

    toggleTrackMute: (trackId) => {
      commitModelMutation((draft) => {
        draft.tracks = draft.tracks.map((track) =>
          track.id === trackId ? { ...track, isMuted: !track.isMuted } : track,
        );
      });
    },

    trimAndPadTracks: () => {
      commitModelMutation((draft) => {
        maybeTrimAndPadTracks(draft);
      });
    },

    undo: () => {
      const entry = undoStack.pop();
      if (!entry) return false;

      const currentModel = getCurrentModelState(get());
      const nextModel = applyPatches(
        currentModel,
        entry.inversePatches,
      ) as TimelineModelState;

      redoStack.push(entry);

      set((state) => ({
        tracks: nextModel.tracks,
        clips: nextModel.clips,
        selectedClipIds: sanitizeSelectedClipIds(
          state.selectedClipIds,
          nextModel.clips,
        ),
        ...applyHistoryFlags(),
      }));

      queueTimelinePatchesForPersistence(entry.inversePatches);
      return true;
    },

    redo: () => {
      const entry = redoStack.pop();
      if (!entry) return false;

      const currentModel = getCurrentModelState(get());
      const nextModel = applyPatches(
        currentModel,
        entry.forwardPatches,
      ) as TimelineModelState;

      undoStack.push(entry);
      if (undoStack.length > TIMELINE_HISTORY_LIMIT) {
        undoStack.shift();
      }

      set((state) => ({
        tracks: nextModel.tracks,
        clips: nextModel.clips,
        selectedClipIds: sanitizeSelectedClipIds(
          state.selectedClipIds,
          nextModel.clips,
        ),
        ...applyHistoryFlags(),
      }));

      queueTimelinePatchesForPersistence(entry.forwardPatches);
      return true;
    },

    replaceTimelineSnapshot,

    flushPendingPersistence: async () => {
      await flushPendingPersistence();
    },

    getClipsAtTime: (time) => {
      const { clips } = get();
      return clips.filter(
        (clip) =>
          clip.type !== "mask" &&
          clip.start <= time &&
          clip.start + clip.timelineDuration > time,
      );
    },
  };
});
