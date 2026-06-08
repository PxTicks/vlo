import { enablePatches } from "../../lib/immerLite";
import { create } from "zustand";
import type {
  Component,
  MaskCompositionAlgebra,
} from "../../types/Components";
import type { Asset } from "../../types/Asset";
import type {
  AdjustmentDepth,
  AdjustmentRetimingMode,
  ClipMask,
  ClipTransform,
  MaskBooleanExpression,
  TextClipData,
  TimelineClip,
  TimelineTrack,
} from "../../types/TimelineTypes";
import { isCompositeClip } from "../../types/TimelineTypes";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import {
  countBrushMaskAssetConsumers,
  countSam2MaskAssetConsumers,
  makeMaskClipId,
  migrateLegacyMaskEdgeTransforms,
  parseMaskClipId,
} from "./model/maskClipModel";
import {
  addClipComponentToDraft,
  addClipMaskToDraft,
  addClipsToDraft,
  addClipToDraft,
  addClipTransformToDraft,
  addTrackToDraft,
  clipReferencesAssetId,
  copySelectedClips,
  duplicateClipMaskInDraft,
  duplicateTimelineClip,
  getTimelineClipsAtTime,
  insertTrackIntoDraft,
  moveClipsInDraft,
  pasteCopiedClipsAboveDraft,
  planTimelineRemoval,
  removeClipComponentFromDraft,
  removeClipIdsFromDraft,
  removeClipTransformFromDraft,
  replaceClipAssetInDraft,
  setClipMaskBooleanExpressionInDraft,
  setClipMaskCompositionAlgebraInDraft,
  setClipMaskCompositeTransformsInDraft,
  setClipTransformsAndShapeInDraft,
  setClipTransformsInDraft,
  splitClipInDraft,
  toggleClipMuteInDraft,
  toggleTrackMuteInDraft,
  toggleTrackVisibilityInDraft,
  trimAndPadTracksInDraft,
  updateClipComponentInDraft,
  updateClipDurationInDraft,
  updateClipMaskInDraft,
  updateClipPositionInDraft,
  updateClipShapeInDraft,
  updateTextClipDataInDraft,
  updateClipTransformInDraft,
  withTimelineClipDefaults,
  type TimelineClipMove,
  type TimelineClipShape,
  type TimelineMaskUpdate,
} from "./model/timelineCommands";
import {
  createDefaultTimelineSnapshot,
  createNewTrack,
  type TimelineModelState,
} from "./model/timelineTrackModel";
import {
  createAdjustmentClipInDraft,
  insertAdjustmentTrackInDraft,
  setAdjustmentDepthInDraft,
  setAdjustmentRetimingModeInDraft,
  type CreateAdjustmentClipInput,
} from "./model/adjustmentClipCommands";
import {
  selectMaskClipsForParent,
  selectResolvedMaskBooleanExpressionForParent,
} from "./selectors/timelineSelectors";
import { createTimelineMutationPipeline } from "./store/timelineMutationPipeline";
import { useAssetStore } from "../userAssets/useAssetStore";
import { durationSecondsToTicks } from "./utils/assetDuration";

enablePatches();

function isCompositeFullLengthTiming(clip: TimelineClip): boolean {
  return (
    isCompositeClip(clip) &&
    clip.sourceDuration !== null &&
    clip.offset === 0 &&
    clip.transformedOffset === 0 &&
    clip.timelineDuration === clip.sourceDuration &&
    clip.croppedSourceDuration === clip.sourceDuration &&
    clip.transformedDuration === clip.sourceDuration
  );
}

export {
  countBrushMaskAssetConsumers,
  countSam2MaskAssetConsumers,
  parseMaskClipId,
  selectMaskClipsForParent,
  selectResolvedMaskBooleanExpressionForParent,
};

interface TimelineState extends TimelineModelState {
  selectedClipIds: string[];
  copiedClips: TimelineClip[];
  canUndo: boolean;
  canRedo: boolean;

  duplicateClip: (clip: TimelineClip) => TimelineClip;
  copySelectedClip: () => boolean;
  pasteCopiedClipAbove: () => boolean;
  splitClip: (clipId: string, splitTime: number) => void;

  addTrack: () => void;
  insertTrack: (index: number, type?: TimelineTrack["type"]) => string;

  addClip: (clip: TimelineClip) => void;
  addClipsOnNewTracksBelow: (
    sourceTrackId: string,
    entries: {
      trackLabel: string;
      trackType?: TimelineTrack["type"];
      createClip: (trackId: string) => TimelineClip;
    }[],
  ) => string[];
  /**
   * Atomically replaces `sourceClipIds` (and their subordinate clips) with a
   * single composite clip in one undoable step. Deliberately skips SAM2/brush
   * post-commit cleanup: the absorbed clips' mask assets live on inside the
   * composite's content for re-baking.
   */
  groupClipsIntoComposite: (
    sourceClipIds: string[],
    compositeClip: TimelineClip,
  ) => boolean;
  /**
   * Repoints every placement of a composite at its freshly baked asset (called
   * after create/edit). Placements are ordinary video clips whose `assetId` is
   * the bake; this is the only composite-specific timeline operation.
   */
  relinkCompositePlacements: (
    compositeId: string,
    bakedAssetId: string,
  ) => void;

  removeClip: (id: string) => void;
  removeClips: (ids: string[]) => boolean;
  moveClips: (
    moves: TimelineClipMove[],
    options?: {
      insertTrack?: { index: number; track: TimelineTrack };
    },
  ) => boolean;
  removeClipsByAssetId: (assetId: string) => number;
  replaceClipAsset: (clipId: string, asset: Asset) => void;

  selectClip: (id: string | null, isMulti?: boolean) => void;

  updateClipPosition: (
    id: string,
    newStartTicks: number,
    newTrackId?: string,
  ) => void;

  updateClipShape: (
    id: string,
    shape: TimelineClipShape,
  ) => void;
  updateTextClipData: (
    clipId: string,
    updates: Partial<TextClipData>,
  ) => void;

  updateClipDuration: (id: string, newDurationTicks: number) => void;

  addClipTransform: (clipId: string, effect: ClipTransform) => void;

  updateClipTransform: (
    clipId: string,
    effectId: string,
    updates: Partial<Omit<ClipTransform, "id" | "type">>,
  ) => void;

  setClipTransforms: (clipId: string, transforms: ClipTransform[]) => void;
  setClipTransformsAndShape: (
    clipId: string,
    transforms: ClipTransform[],
    shape: TimelineClipShape,
  ) => void;
  setClipMaskCompositeTransforms: (
    clipId: string,
    transforms: ClipTransform[],
  ) => void;
  setClipMaskCompositionAlgebra: (
    clipId: string,
    algebra: MaskCompositionAlgebra,
  ) => void;
  setClipMaskBooleanExpression: (
    clipId: string,
    expression: MaskBooleanExpression | null,
  ) => void;

  removeClipTransform: (clipId: string, effectId: string) => void;

  addClipMask: (clipId: string, mask: ClipMask) => void;
  duplicateClipMask: (clipId: string, maskId: string) => string | null;

  updateClipMask: (
    clipId: string,
    maskId: string,
    updates: TimelineMaskUpdate,
  ) => void;

  removeClipMask: (clipId: string, maskId: string) => void;

  addClipComponent: (clipId: string, component: Component) => void;
  updateClipComponent: (
    clipId: string,
    componentId: string,
    updater: (component: Component) => Component,
  ) => void;
  removeClipComponent: (clipId: string, componentId: string) => void;

  toggleTrackVisibility: (trackId: string) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleClipMute: (clipId: string) => void;
  trimAndPadTracks: () => void;

  /** Insert a new adjustment-type track at `index` (default: top of stack).
   *  Returns the new track's id. */
  insertAdjustmentTrack: (index?: number) => string;
  /** Create an adjustment clip. If `trackId` is omitted, reuses the
   *  top-most adjustment track or inserts a fresh one. Returns the new
   *  clip's id, or null if inputs were invalid / rule 2 rejected. */
  addAdjustmentClip: (input: CreateAdjustmentClipInput) => string | null;
  /** Update an existing adjustment clip's depth. */
  setAdjustmentDepth: (clipId: string, depth: AdjustmentDepth) => boolean;
  /** Update how adjustment speed transforms affect timeline placement. */
  setAdjustmentRetimingMode: (
    clipId: string,
    retimingMode: AdjustmentRetimingMode,
  ) => boolean;

  undo: () => boolean;
  redo: () => boolean;

  replaceTimelineSnapshot: (snapshot: TimelineSnapshot | null) => void;
  setTimelinePersistenceSuspended: (suspended: boolean) => void;
  flushPendingPersistence: () => Promise<void>;

  getClipsAtTime: (timeTicks: number) => TimelineClip[];
}

export const useTimelineStore = create<TimelineState>((set, get) => {
  const mutationPipeline = createTimelineMutationPipeline<TimelineState>({
    get,
    set,
    createDefaultTimelineSnapshot,
    migrateTimelineSnapshot: (snapshot) => ({
      tracks: structuredClone(snapshot.tracks),
      clips: migrateLegacyMaskEdgeTransforms(
        structuredClone(snapshot.clips),
        withTimelineClipDefaults,
      ),
    }),
  });

  mutationPipeline.registerBeforeUnloadPersistence();

  const initial = createDefaultTimelineSnapshot();
  const removeClipsFromTimeline = (clipIds: string[]): boolean => {
    const normalizedClipIds = [...new Set(clipIds.filter(Boolean))];
    if (normalizedClipIds.length === 0) {
      return false;
    }

    // Group removals into a single commit so undo/redo restores the set
    // atomically instead of stepping through one clip at a time.
    const removalPlan = planTimelineRemoval(get().clips, normalizedClipIds);
    const didCommit = mutationPipeline.commitModelMutation((draft) => {
      removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
    });

    if (didCommit) {
      mutationPipeline.runPostCommitEffects(removalPlan);
    }

    return didCommit;
  };
  const moveClipsOnTimeline = (
    moves: TimelineClipMove[],
    options?: {
      insertTrack?: { index: number; track: TimelineTrack };
    },
  ): boolean => {
    const clipsById = new Map(
      get().clips.map((clip) => [clip.id, clip] as const),
    );
    const effectiveMoves = moves.filter((move) => {
      const clip = clipsById.get(move.clipId);
      if (!clip || clip.type === "mask") {
        return false;
      }

      const nextStart = Math.round(Math.max(0, move.start));
      const nextTrackId = move.trackId ?? clip.trackId;
      return nextStart !== clip.start || nextTrackId !== clip.trackId;
    });

    if (effectiveMoves.length === 0) {
      return false;
    }

    return mutationPipeline.commitModelMutation((draft) => {
      if (options?.insertTrack) {
        insertTrackIntoDraft(
          draft,
          options.insertTrack.index,
          options.insertTrack.track,
        );
      }

      moveClipsInDraft(draft, effectiveMoves);
    });
  };

  return {
    tracks: initial.tracks,
    clips: initial.clips,
    selectedClipIds: [],
    copiedClips: [],
    canUndo: false,
    canRedo: false,

    addTrack: () => {
      mutationPipeline.commitModelMutation((draft) => {
        addTrackToDraft(draft);
      });
    },

    insertTrack: (index, type) => {
      const newTrack = createNewTrack("New Track", type);
      mutationPipeline.commitModelMutation((draft) => {
        insertTrackIntoDraft(draft, index, newTrack);
      });
      return newTrack.id;
    },

    addClip: (clip) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipToDraft(draft, clip);
      });
    },

    addClipsOnNewTracksBelow: (sourceTrackId, entries) => {
      if (entries.length === 0) {
        return [];
      }

      const newTracks = entries.map((entry) =>
        createNewTrack(entry.trackLabel, entry.trackType),
      );
      let addedClipIds: string[] = [];

      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        const sourceTrackIndex = draft.tracks.findIndex(
          (track) => track.id === sourceTrackId,
        );
        const insertIndex =
          sourceTrackIndex >= 0 ? sourceTrackIndex + 1 : draft.tracks.length;

        newTracks.forEach((track, offset) => {
          insertTrackIntoDraft(draft, insertIndex + offset, track);
        });

        addedClipIds = addClipsToDraft(
          draft,
          entries.map((entry, index) => entry.createClip(newTracks[index].id)),
        );
      });

      if (didCommit && addedClipIds.length > 0) {
        set({ selectedClipIds: addedClipIds });
        return addedClipIds;
      }

      return [];
    },

    groupClipsIntoComposite: (sourceClipIds, compositeClip) => {
      const removalPlan = planTimelineRemoval(get().clips, sourceClipIds);
      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        // Add the composite BEFORE removing the source clips. If we removed
        // first, grouping the *entire* timeline would leave every track empty
        // mid-mutation, at which point maybeTrimAndPadTracks rebuilds the track
        // list with brand-new ids — deleting the very track the composite was
        // about to land on. The composite would then be pushed onto a track
        // that no longer exists, orphaning it and wiping the timeline. Adding
        // first keeps the target track populated throughout, so it survives the
        // removal.
        addClipToDraft(draft, compositeClip);

        // Safety net: if the composite could not be placed (e.g. addClipToDraft
        // rejected it on a track-type mismatch), bail out without removing
        // anything. Returning here leaves the draft untouched, so the commit
        // produces no patches and the timeline is left exactly as it was rather
        // than being emptied.
        const placed = draft.clips.some((clip) => clip.id === compositeClip.id);
        if (!placed) {
          return;
        }

        removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
      });

      // Note: post-commit cleanup is intentionally NOT run — the absorbed
      // clips' SAM2/brush mask assets are still referenced by the composite's
      // content and must survive for editing/re-baking.
      if (didCommit) {
        set({ selectedClipIds: [compositeClip.id] });
      }
      return didCommit;
    },

    relinkCompositePlacements: (compositeId, bakedAssetId) => {
      // A composite was (re)baked. Repoint every placement of it at the new
      // baked asset so they render through the ordinary video path. Full-length
      // placements re-align to the new bake's real (frame-snapped) duration.
      const bakedDurationTicks =
        durationSecondsToTicks(
          useAssetStore
            .getState()
            .assets.find((asset) => asset.id === bakedAssetId)?.duration,
        ) ?? null;
      mutationPipeline.commitModelMutation((draft) => {
        draft.clips = draft.clips.map((clip) =>
          isCompositeClip(clip) && clip.compositeId === compositeId
            ? {
                ...clip,
                assetId: bakedAssetId,
                ...(bakedDurationTicks !== null &&
                isCompositeFullLengthTiming(clip)
                  ? {
                      sourceDuration: bakedDurationTicks,
                      timelineDuration: bakedDurationTicks,
                      croppedSourceDuration: bakedDurationTicks,
                      offset: 0,
                      transformedDuration: bakedDurationTicks,
                      transformedOffset: 0,
                    }
                  : {}),
              }
            : clip,
        );
      });
    },

    duplicateClip: (clip) => duplicateTimelineClip(clip, get().clips),

    copySelectedClip: () => {
      const { selectedClipIds, clips, tracks } = get();
      const copiedClips = copySelectedClips(selectedClipIds, clips, tracks);
      if (copiedClips.length === 0) {
        return false;
      }

      set({ copiedClips });
      return true;
    },

    pasteCopiedClipAbove: () => {
      const { copiedClips } = get();
      let pastedClipIds: string[] = [];

      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        pastedClipIds = pasteCopiedClipsAboveDraft(draft, copiedClips);
      });

      if (!didCommit || pastedClipIds.length === 0) {
        return false;
      }

      set({ selectedClipIds: pastedClipIds });
      return true;
    },

    splitClip: (clipId, splitTime) => {
      let rightClipId: string | null = null;

      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        rightClipId = splitClipInDraft(draft, clipId, splitTime);
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
      removeClipsFromTimeline([id]);
    },

    removeClips: (ids) => {
      return removeClipsFromTimeline(ids);
    },

    moveClips: (moves, options) => {
      return moveClipsOnTimeline(moves, options);
    },

    removeClipsByAssetId: (assetId) => {
      const directlyReferencedClipIds = get()
        .clips
        .filter((clip) => clipReferencesAssetId(clip, assetId))
        .map((clip) => clip.id);

      if (directlyReferencedClipIds.length === 0) {
        return 0;
      }

      const removalPlan = planTimelineRemoval(get().clips, directlyReferencedClipIds);
      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
      });

      if (didCommit) {
        mutationPipeline.runPostCommitEffects(removalPlan);
      }

      return directlyReferencedClipIds.length;
    },

    replaceClipAsset: (clipId, asset) => {
      mutationPipeline.commitModelMutation((draft) => {
        replaceClipAssetInDraft(draft, clipId, asset);
      });
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
      mutationPipeline.commitModelMutation((draft) => {
        updateClipPositionInDraft(draft, id, newStartTicks, newTrackId);
      });
    },

    updateClipShape: (id, shape) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipShapeInDraft(draft, id, shape);
      });
    },

    updateTextClipData: (clipId, updates) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateTextClipDataInDraft(draft, clipId, updates);
      });
    },

    updateClipDuration: (id, newDurationTicks) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipDurationInDraft(draft, id, newDurationTicks);
      });
    },

    addClipTransform: (clipId, effect) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipTransformToDraft(draft, clipId, effect);
      });
    },

    updateClipTransform: (clipId, effectId, updates) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipTransformInDraft(draft, clipId, effectId, updates);
      });
    },

    setClipTransforms: (clipId, transforms) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipTransformsInDraft(draft, clipId, transforms);
      });
    },

    setClipTransformsAndShape: (clipId, transforms, shape) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipTransformsAndShapeInDraft(draft, clipId, transforms, shape);
      });
    },

    setClipMaskCompositeTransforms: (clipId, transforms) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipMaskCompositeTransformsInDraft(draft, clipId, transforms);
      });
    },

    setClipMaskCompositionAlgebra: (clipId, algebra) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipMaskCompositionAlgebraInDraft(draft, clipId, algebra);
      });
    },

    setClipMaskBooleanExpression: (clipId, expression) => {
      mutationPipeline.commitModelMutation((draft) => {
        setClipMaskBooleanExpressionInDraft(draft, clipId, expression);
      });
    },

    removeClipTransform: (clipId, effectId) => {
      mutationPipeline.commitModelMutation((draft) => {
        removeClipTransformFromDraft(draft, clipId, effectId);
      });
    },

    addClipMask: (clipId, mask) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipMaskToDraft(draft, clipId, mask);
      });
    },

    duplicateClipMask: (clipId, maskId) => {
      let duplicatedMaskId: string | null = null;

      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        duplicatedMaskId = duplicateClipMaskInDraft(draft, clipId, maskId);
      });

      return didCommit ? duplicatedMaskId : null;
    },

    updateClipMask: (clipId, maskId, updates) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipMaskInDraft(draft, clipId, maskId, updates);
      });
    },

    removeClipMask: (clipId, maskId) => {
      const maskClipId = makeMaskClipId(clipId, maskId);
      const removalPlan = planTimelineRemoval(get().clips, [maskClipId]);
      const didCommit = mutationPipeline.commitModelMutation((draft) => {
        removeClipIdsFromDraft(draft, removalPlan.clipIdsToRemove);
      });

      if (didCommit) {
        mutationPipeline.runPostCommitEffects(removalPlan);
      }
    },

    addClipComponent: (clipId, component) => {
      mutationPipeline.commitModelMutation((draft) => {
        addClipComponentToDraft(draft, clipId, component);
      });
    },

    updateClipComponent: (clipId, componentId, updater) => {
      mutationPipeline.commitModelMutation((draft) => {
        updateClipComponentInDraft(draft, clipId, componentId, updater);
      });
    },

    removeClipComponent: (clipId, componentId) => {
      mutationPipeline.commitModelMutation((draft) => {
        removeClipComponentFromDraft(draft, clipId, componentId);
      });
    },

    toggleTrackVisibility: (trackId) => {
      mutationPipeline.commitModelMutation((draft) => {
        toggleTrackVisibilityInDraft(draft, trackId);
      });
    },

    toggleTrackMute: (trackId) => {
      mutationPipeline.commitModelMutation((draft) => {
        toggleTrackMuteInDraft(draft, trackId);
      });
    },

    toggleClipMute: (clipId) => {
      mutationPipeline.commitModelMutation((draft) => {
        toggleClipMuteInDraft(draft, clipId);
      });
    },

    trimAndPadTracks: () => {
      mutationPipeline.commitModelMutation((draft) => {
        trimAndPadTracksInDraft(draft);
      });
    },

    insertAdjustmentTrack: (index) => {
      let trackId = "";
      mutationPipeline.commitModelMutation((draft) => {
        trackId = insertAdjustmentTrackInDraft(draft, index);
      });
      return trackId;
    },

    addAdjustmentClip: (input) => {
      let id: string | null = null;
      mutationPipeline.commitModelMutation((draft) => {
        id = createAdjustmentClipInDraft(draft, input);
      });
      return id;
    },

    setAdjustmentDepth: (clipId, depth) => {
      let ok = false;
      mutationPipeline.commitModelMutation((draft) => {
        ok = setAdjustmentDepthInDraft(draft, clipId, depth);
      });
      return ok;
    },

    setAdjustmentRetimingMode: (clipId, retimingMode) => {
      let ok = false;
      mutationPipeline.commitModelMutation((draft) => {
        ok = setAdjustmentRetimingModeInDraft(draft, clipId, retimingMode);
      });
      return ok;
    },

    undo: () => mutationPipeline.undo(),
    redo: () => mutationPipeline.redo(),
    replaceTimelineSnapshot: mutationPipeline.replaceTimelineSnapshot,
    setTimelinePersistenceSuspended: mutationPipeline.setPersistenceSuspended,
    flushPendingPersistence: mutationPipeline.flushPendingPersistence,

    getClipsAtTime: (timeTicks) => getTimelineClipsAtTime(get().clips, timeTicks),
  };
});

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__TIMELINE_STORE__ =
    useTimelineStore;
}
