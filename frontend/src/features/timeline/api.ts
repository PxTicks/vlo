import { useShallow } from "zustand/react/shallow";
import type { Asset } from "../../types/Asset";
import type {
  Component,
  MaskCompositionAlgebra,
} from "../../types/Components";
import { resolveMaskCompositionAlgebra } from "../../types/Components";
import type {
  AdjustmentDepth,
  AdjustmentRetimingMode,
  BaseClip,
  ClipMask,
  ExtensionTimelineClip,
  ClipTransform,
  CompositeContent,
  MaskBooleanExpression,
  MaskTimelineClip,
  TextClipData,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../types/TimelineTypes";
import {
  isCompositeClip,
  isExtensionTimelineClip,
} from "../../types/TimelineTypes";
import type {
  ExtensionMaskCompositionSnapshot,
  ExtensionMaskExpression,
  ExtensionRangeMaskSnapshot,
  ExtensionSelectionFailureCode,
  ExtensionSelectionResult,
  ExtensionSelectionSnapshot,
  ExtensionTimelineEntitySnapshot,
  ExtensionTimelineClipSnapshot,
  ExtensionTimelineMaskSnapshot,
  ExtensionTimelineTrackSnapshot,
  ExtensionTimelineTransitionSnapshot,
  ExtensionTimelineTransformSnapshot,
  JsonValue,
  ExtensionTimelineTransactionResult,
  ExtensionTimelineTransactionOptions,
} from "@vlo/extension-sdk";
import type { TimelineSnapshot } from "../project/types/ProjectDocument";
import { TICKS_PER_SECOND } from "../../core/time/constants";
import { createRevisionRelay, type RevisionSource } from "../../core/shell/revisionRelay";
import {
  selectMaskClipsForParent,
  selectPrimaryActiveClip,
  selectTimelineClipById,
  selectTimelineClipCountForAsset,
  selectTimelineClipsForTrack,
  selectTimelineDuration,
} from "./selectors/timelineSelectors";
import { useTimelineStore } from "./useTimelineStore";
import { useTimelineViewStore } from "./hooks/useTimelineViewStore";
import { useProjectStore } from "../project/useProjectStore";
import type { ExtensionTimelineCommand } from "./model/extensionTimelineCommands";
import { createDefaultTimelineSnapshot } from "./model/timelineTrackModel";
import { parseMaskClipId } from "./model/maskClipModel";
import type {
  TimelineClipMove,
  TimelineClipShape,
  TimelineMaskUpdate,
} from "./model/timelineCommands";
import { computeFurthestPresentationEnd } from "./utils/clipPresentation";
import {
  createTimelinePlacementMapper,
  timelinePresentationRange,
} from "./utils/timelinePlacementMapper";
import {
  resolveClipsAtPlayhead,
  resolveMarkerPlacementsAtPlayhead,
  resolveSplitPointsAtPlayhead,
  type MarkerPlacement,
  type SplitPoint,
} from "./model/playheadPlacement";
import { createClipFromAsset } from "./utils/clipFactory";
import {
  insertAssetAtTime,
  insertBaseClipAtTime,
} from "./utils/insertAssetToTimeline";

type TimelineStoreState = ReturnType<typeof useTimelineStore.getState>;
type AddTimelineClipsOnNewTracksEntry =
  Parameters<TimelineStoreState["addClipsOnNewTracksBelow"]>[1][number];
type UpdateTimelineClipTransformPayload = Partial<
  Omit<ClipTransform, "id" | "type">
>;
type UpdateTimelineClipComponentFn = (component: Component) => Component;

export {
  selectMaskClipsForParent,
  selectPrimaryActiveClip,
  selectTimelineClipById,
  selectTimelineClipCountForAsset,
  selectTimelineClipsForTrack,
  selectTimelineDuration,
  parseMaskClipId,
};

/** Host composition-root seam; ordinary feature consumers should use selectors. */
export function getTimelineStoreForTrustedHostAccess(): typeof useTimelineStore {
  return useTimelineStore;
}

// Commit-grained model signal shared by host adapters. Selection and in-flight
// interactions keep these references stable, so neither wakes model readers.
let timelineModelRevisionSource: RevisionSource | null = null;

export function getTimelineModelRevisionSource(): RevisionSource {
  timelineModelRevisionSource ??= createRevisionRelay(
    useTimelineStore,
    (state) => [state.clips, state.tracks, state.transitions],
  );
  return timelineModelRevisionSource;
}

export interface TimelineViewGeometry {
  absolutePx: number;
  zoomScale: number;
}

/** Read-only host seam for mapping a project tick through the current view. */
export function getTimelineViewGeometry(tick: number): TimelineViewGeometry {
  const view = useTimelineViewStore.getState();
  return {
    absolutePx: view.ticksToPx(tick),
    zoomScale: view.zoomScale,
  };
}

export { installTimelineHostCommands } from "./hostCommands";

export function useTimelineClip(
  clipId: string | null | undefined,
): TimelineClip | undefined {
  return useTimelineStore((state) => selectTimelineClipById(state, clipId));
}

export function usePrimaryActiveClip(): TimelineClip | undefined {
  return useTimelineStore(selectPrimaryActiveClip);
}

export function useTimelineClips(): TimelineClip[] {
  return useTimelineStore(useShallow((state) => state.clips));
}

export function useTimelineTracks(): TimelineTrack[] {
  return useTimelineStore(useShallow((state) => state.tracks));
}

export function useSelectedTimelineClipIds(): string[] {
  return useTimelineStore(useShallow((state) => state.selectedClipIds));
}

export function useSelectedTimelineClipId(): string | null {
  return useTimelineStore((state) => state.selectedClipIds[0] ?? null);
}

export function useTimelineTransitions(): Transition[] {
  return useTimelineStore(useShallow((state) => state.transitions));
}

export function useSelectedTimelineTransitionId(): string | null {
  return useTimelineStore((state) => state.selectedTransitionId);
}

export function useTimelineClipsForTrack(
  trackId: string,
  includeMasks: boolean = true,
): TimelineClip[] {
  return useTimelineStore(
    useShallow((state) =>
      selectTimelineClipsForTrack(state, trackId, includeMasks),
    ),
  );
}

export function useMaskClipsForParent(
  parentClipId: string | null | undefined,
): MaskTimelineClip[] {
  return useTimelineStore(
    useShallow((state) =>
      parentClipId ? selectMaskClipsForParent(state, parentClipId) : [],
    ),
  );
}

export function useTimelineDuration(): number {
  const fps = useProjectStore((state) => state.config.fps);
  return useTimelineStore((state) => selectTimelineDuration(state, fps));
}

export function useTimelineClipCountForAsset(
  assetId: string | null | undefined,
): number {
  return useTimelineStore((state) =>
    selectTimelineClipCountForAsset(state, assetId),
  );
}

export function useTimelineModelState(): Pick<
  TimelineStoreState,
  "clips" | "tracks" | "transitions"
> {
  return useTimelineStore(
    useShallow((state) => ({
      clips: state.clips,
      tracks: state.tracks,
      transitions: state.transitions,
    })),
  );
}

export function getTimelineClips(): TimelineClip[] {
  return useTimelineStore.getState().clips;
}

export function getTimelineTracks(): TimelineTrack[] {
  return useTimelineStore.getState().tracks;
}

export function getTimelineTransitions(): Transition[] {
  return useTimelineStore.getState().transitions;
}

export function getTimelineModelState(): Pick<
  TimelineStoreState,
  "clips" | "tracks" | "transitions"
> {
  const { clips, tracks, transitions } = useTimelineStore.getState();
  return { clips, tracks, transitions };
}

export function getTimelineClipById(
  clipId: string | null | undefined,
): TimelineClip | undefined {
  return selectTimelineClipById(useTimelineStore.getState(), clipId);
}

export function getPrimaryActiveClip(): TimelineClip | undefined {
  return selectPrimaryActiveClip(useTimelineStore.getState());
}

export function getTimelineClipsForTrack(
  trackId: string,
  includeMasks: boolean = true,
): TimelineClip[] {
  return selectTimelineClipsForTrack(
    useTimelineStore.getState(),
    trackId,
    includeMasks,
  );
}

export function getMaskClipsForParent(
  parentClipId: string | null | undefined,
): MaskTimelineClip[] {
  return parentClipId
    ? selectMaskClipsForParent(useTimelineStore.getState(), parentClipId)
    : [];
}

export function getTimelineDuration(): number {
  return selectTimelineDuration(
    useTimelineStore.getState(),
    useProjectStore.getState().config.fps,
  );
}

export function getTimelineClipCountForAsset(
  assetId: string | null | undefined,
): number {
  return selectTimelineClipCountForAsset(useTimelineStore.getState(), assetId);
}

export function getSelectedTimelineClipIds(): string[] {
  return useTimelineStore.getState().selectedClipIds;
}

export function getSelectedTimelineClipId(): string | null {
  return useTimelineStore.getState().selectedClipIds[0] ?? null;
}

export function getSelectedTimelineTransitionId(): string | null {
  return useTimelineStore.getState().selectedTransitionId;
}

export function createEmptyTimelineSnapshot(): TimelineSnapshot {
  return structuredClone(createDefaultTimelineSnapshot());
}

export function getTimelineSnapshot(): TimelineSnapshot {
  const { clips, tracks, transitions } = useTimelineStore.getState();
  return {
    clips: structuredClone(clips),
    tracks: structuredClone(tracks),
    transitions: structuredClone(transitions),
  };
}

export function getTimelinePresentationContext(): {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  fps: number;
} {
  const { clips, tracks } = useTimelineStore.getState();
  return {
    clips,
    tracks,
    fps: useProjectStore.getState().config.fps,
  };
}

/**
 * Return clips whose visible presentation footprint intersects a range, or
 * covers a single tick when `end` is omitted. Mask clips ride along with a
 * covered parent.
 */
export function getTimelineClipsInPresentationRange(
  start: number,
  end?: number,
): TimelineClip[] {
  const { clips, tracks, fps } = getTimelinePresentationContext();
  if (end === undefined) {
    return resolveClipsAtPlayhead({
      tracks,
      clips,
      fps,
      presentationTick: start,
      includeMaskChildren: true,
    });
  }

  const mapper = createTimelinePlacementMapper({ tracks, clips, fps });
  const selectedIds = new Set(
    mapper.getClipIdsInPresentationRange(timelinePresentationRange(start, end)),
  );
  return clips.filter((clip) => selectedIds.has(clip.id));
}

/**
 * Clips the playhead is drawn over, excluding mask children — the set an action
 * that edits the clip itself (markers, beat detection) should operate on.
 */
export function getTimelineClipsAtPlayhead(
  presentationTickValue: number,
): TimelineClip[] {
  const { clips, tracks, fps } = getTimelinePresentationContext();
  return resolveClipsAtPlayhead({
    tracks,
    clips,
    fps,
    presentationTick: presentationTickValue,
  });
}

/**
 * Anchors for "add a marker at the playhead": which clips get one, and the
 * source-media time each marker is pinned to. Presentation-aware, so a clip
 * moved by a ripple retime still anchors under the playhead the user sees.
 * Defaults to preferring the current selection when it is under the playhead.
 */
export function getTimelineMarkerPlacementsAtPlayhead(
  presentationTickValue: number,
  preferredClipIds?: readonly string[],
): MarkerPlacement[] {
  const { clips, tracks, fps } = getTimelinePresentationContext();
  return resolveMarkerPlacementsAtPlayhead({
    tracks,
    clips,
    fps,
    presentationTick: presentationTickValue,
    preferredClipIds:
      preferredClipIds ?? useTimelineStore.getState().selectedClipIds,
  });
}

/**
 * Cuts for "split at the playhead": which clips are cut, each with the stored
 * track tick `splitTimelineClip` expects. Presentation-aware, and pre-filtered
 * to cuts the model will accept. Defaults to the current selection, which
 * restricts the cut (an empty selection is razor mode: every covered clip).
 */
export function getTimelineSplitPointsAtPlayhead(
  presentationTickValue: number,
  selectedClipIds?: readonly string[],
): SplitPoint[] {
  const { clips, tracks, fps } = getTimelinePresentationContext();
  return resolveSplitPointsAtPlayhead({
    tracks,
    clips,
    fps,
    presentationTick: presentationTickValue,
    selectedClipIds:
      selectedClipIds ?? useTimelineStore.getState().selectedClipIds,
  });
}

export function getTimelineCompositeContent(): CompositeContent {
  const { clips, tracks, fps } = getTimelinePresentationContext();
  const transitions = useTimelineStore.getState().transitions;
  const durationTicks = Math.max(
    TICKS_PER_SECOND,
    computeFurthestPresentationEnd(tracks, clips, fps),
  );

  return {
    clips: structuredClone(clips),
    tracks: structuredClone(tracks),
    transitions: structuredClone(transitions),
    durationTicks,
    fps,
    frameStep: 1,
  };
}

export function getTimelineCompositePlacementIds(
  compositeAssetIds: readonly string[],
): string[] {
  const selected = new Set(compositeAssetIds);
  if (selected.size === 0) {
    return [];
  }

  return useTimelineStore
    .getState()
    .clips.filter(
      (clip) => isCompositeClip(clip) && selected.has(clip.compositeId),
    )
    .map((clip) => clip.id);
}

export function getTimelineMaskClipById(
  maskClipId: string,
): MaskTimelineClip | null {
  const clip = useTimelineStore
    .getState()
    .clips.find((candidate) => candidate.id === maskClipId);
  return clip?.type === "mask" ? clip : null;
}

export function getTimelineMaskClipForParent(
  parentClipId: string,
  maskId: string,
): MaskTimelineClip | null {
  const maskClipId = `${parentClipId}::mask::${maskId}`;
  return getTimelineMaskClipById(maskClipId);
}

export function getTimelineBrushMaskClipIds(): string[] {
  return useTimelineStore
    .getState()
    .clips.filter(
      (clip): clip is MaskTimelineClip =>
        clip.type === "mask" && clip.maskType === "brush",
    )
    .map((clip) => clip.id);
}

export function getTimelineBrushMaskAssetConsumerCount(
  brushMaskAssetId: string,
): number {
  return useTimelineStore
    .getState()
    .clips.reduce(
      (count, clip) =>
        clip.type === "mask" && clip.brushMaskAssetId === brushMaskAssetId
          ? count + 1
          : count,
      0,
    );
}

export function getTimelineSam2MaskAssetConsumerCount(
  sam2MaskAssetId: string,
): number {
  return useTimelineStore
    .getState()
    .clips.reduce(
      (count, clip) =>
        clip.type === "mask" && clip.sam2MaskAssetId === sam2MaskAssetId
          ? count + 1
          : count,
      0,
    );
}

export function getExtensionTimelineEntities(
  ownerId: string,
): readonly ExtensionTimelineEntitySnapshot[] {
  return Object.freeze(
    useTimelineStore
      .getState()
      .clips.filter(
        (clip): clip is ExtensionTimelineClip =>
          isExtensionTimelineClip(clip) &&
          clip.extensionPayload.extensionId === ownerId,
      )
      .map((clip) =>
        Object.freeze({
          id: clip.id,
          trackId: clip.trackId,
          startTicks: clip.start,
          durationTicks: clip.timelineDuration,
          payload: structuredClone(clip.extensionPayload),
        }),
      ),
  );
}

/** Projects the host's boolean mask tree, naming masks by clip-local ID. */
function toExtensionMaskExpression(
  expression: MaskBooleanExpression,
): ExtensionMaskExpression {
  if (expression.kind === "mask_ref") {
    return Object.freeze({
      kind: "mask" as const,
      maskId: parseMaskClipId(expression.maskId)?.maskId ?? expression.maskId,
    });
  }
  return Object.freeze({
    kind: "operation" as const,
    operator: expression.operator,
    left: toExtensionMaskExpression(expression.left),
    right: toExtensionMaskExpression(expression.right),
  });
}

function toExtensionMaskComposition(
  clip: TimelineClip,
): ExtensionMaskCompositionSnapshot | undefined {
  if (clip.type === "mask") return undefined;
  const component = (clip.components ?? []).find(
    (candidate) => candidate.type === "mask_composition",
  );
  if (component?.type !== "mask_composition") return undefined;
  const { expression, expressionEnabled } = component.parameters;
  return Object.freeze({
    // The model's tri-state is absent = auto-union, null = explicitly off,
    // object = authored. Collapsing the first two would report a clip that
    // merely carries edge transforms or an algebra — which is what attaching a
    // generated mask produces — as having masking switched off.
    expression:
      expression === undefined
        ? ("auto" as const)
        : expression === null
          ? ("none" as const)
          : toExtensionMaskExpression(expression),
    isEnabled: expressionEnabled !== false,
    algebra: resolveMaskCompositionAlgebra(component.parameters),
  });
}

function toExtensionRangeMasks(
  clip: TimelineClip,
): readonly ExtensionRangeMaskSnapshot[] {
  if (clip.type === "mask") return Object.freeze([]);
  return Object.freeze(
    (clip.components ?? [])
      .filter((component) => component.type === "range_mask")
      .map((component) =>
        Object.freeze({
          id: component.id,
          startSourceTicks: component.parameters.startSourceTicks,
          endSourceTicks: component.parameters.endSourceTicks,
          isActive: component.parameters.isActive,
          ...(component.parameters.name === undefined
            ? {}
            : { name: component.parameters.name }),
        }),
      ),
  );
}

export function toExtensionClipSnapshot(
  clip: TimelineClip,
): ExtensionTimelineClipSnapshot {
  const composition = toExtensionMaskComposition(clip);
  return Object.freeze({
    id: clip.id,
    type: clip.type,
    name: clip.name,
    trackId: clip.trackId,
    startTicks: clip.start,
    durationTicks: clip.timelineDuration,
    sourceOffsetTicks: clip.offset,
    sourceDurationTicks: clip.sourceDuration,
    croppedSourceDurationTicks: clip.croppedSourceDuration,
    isMuted:
      clip.type !== "mask" && "isMuted" in clip ? clip.isMuted === true : false,
    ...("compositeId" in clip && typeof clip.compositeId === "string"
      ? { compositeId: clip.compositeId }
      : {}),
    ...(composition ? { maskComposition: composition } : {}),
    rangeMasks: toExtensionRangeMasks(clip),
    ...("assetId" in clip && typeof clip.assetId === "string"
      ? { assetId: clip.assetId }
      : {}),
    transformations: structuredClone(clip.transformations).map(
      (transform): ExtensionTimelineTransformSnapshot => ({
        id: transform.id,
        type: transform.type,
        isEnabled: transform.isEnabled,
        parameters: transform.parameters as Record<string, JsonValue>,
        ...(transform.keyframeTimes
          ? { keyframeTimes: transform.keyframeTimes }
          : {}),
        ...(transform.templateId ? { templateId: transform.templateId } : {}),
        ...("filterName" in transform &&
        typeof transform.filterName === "string"
          ? { filterName: transform.filterName }
          : {}),
      }),
    ),
  });
}

function toExtensionTransformSnapshot(
  transform: ClipTransform,
): ExtensionTimelineTransformSnapshot {
  return {
    id: transform.id,
    type: transform.type,
    isEnabled: transform.isEnabled,
    parameters: transform.parameters as Record<string, JsonValue>,
    ...(transform.keyframeTimes ? { keyframeTimes: transform.keyframeTimes } : {}),
    ...(transform.templateId ? { templateId: transform.templateId } : {}),
    ...("filterName" in transform && typeof transform.filterName === "string"
      ? { filterName: transform.filterName }
      : {}),
  };
}

function getMaskAssetId(maskClip: MaskTimelineClip): string | undefined {
  if (maskClip.maskType === "sam2") return maskClip.sam2MaskAssetId;
  if (maskClip.maskType === "generation") return maskClip.generationMaskAssetId;
  if (maskClip.maskType === "brush") return maskClip.brushMaskAssetId;
  return undefined;
}

export function toExtensionMaskSnapshot(
  maskClip: MaskTimelineClip,
): ExtensionTimelineMaskSnapshot {
  const parsed = parseMaskClipId(maskClip.id);
  return Object.freeze({
    id: maskClip.id,
    parentClipId: maskClip.parentClipId ?? parsed?.clipId ?? "",
    localId: parsed?.maskId ?? maskClip.id,
    name: maskClip.name,
    startTicks: maskClip.start,
    durationTicks: maskClip.timelineDuration,
    maskType: maskClip.maskType,
    maskMode: maskClip.maskMode,
    maskInverted: maskClip.maskInverted,
    parameters: structuredClone(maskClip.maskParameters) as unknown as Record<
      string,
      JsonValue
    >,
    ...(getMaskAssetId(maskClip)
      ? { assetId: getMaskAssetId(maskClip) }
      : {}),
    ...(maskClip.brushPaintedBounds
      ? { paintedBounds: { ...maskClip.brushPaintedBounds } }
      : {}),
    ...(maskClip.activeRange
      ? { activeRange: { ...maskClip.activeRange } }
      : {}),
    transformations: structuredClone(maskClip.transformations).map(
      toExtensionTransformSnapshot,
    ),
  });
}

export function toExtensionTransitionSnapshot(
  transition: Transition,
): ExtensionTimelineTransitionSnapshot {
  return Object.freeze({
    id: transition.id,
    type: transition.type,
    outgoingClipId: transition.outgoingClipId,
    incomingClipId: transition.incomingClipId,
    ...(transition.schemaVersion
      ? { schemaVersion: transition.schemaVersion }
      : {}),
    parameters: structuredClone(transition.parameters) as Record<
      string,
      JsonValue
    >,
  });
}

export function getExtensionTimelineClips(): readonly ExtensionTimelineClipSnapshot[] {
  return Object.freeze(
    useTimelineStore.getState().clips.map(toExtensionClipSnapshot),
  );
}

export function getExtensionTimelineTracks(): readonly ExtensionTimelineTrackSnapshot[] {
  return Object.freeze(
    useTimelineStore.getState().tracks.map((track, index) =>
      Object.freeze({
        id: track.id,
        index,
        label: track.label,
        // Legacy tracks carry no type. The host treats those as visual, but
        // the projection reports the absence rather than asserting a class the
        // model never recorded.
        type: track.type ?? null,
        isVisible: track.isVisible,
        isMuted: track.isMuted,
        isLocked: track.isLocked,
      }),
    ),
  );
}

/**
 * The editor selection, detached. Clip and transition selection are mutually
 * exclusive in the store, and this projection preserves that.
 */
export function getExtensionTimelineSelection(): ExtensionSelectionSnapshot {
  const state = useTimelineStore.getState();
  return Object.freeze({
    clipIds: Object.freeze([...state.selectedClipIds]),
    transitionId: state.selectedTransitionId,
  });
}

function selectionFailure(
  code: ExtensionSelectionFailureCode,
  message: string,
): ExtensionSelectionResult {
  return Object.freeze({ ok: false as const, code, message });
}

/**
 * Replaces the clip selection on behalf of an extension. Validation is
 * all-or-nothing so a selection never half-applies: an unknown ID is a bug in
 * the caller's bookkeeping, and applying the rest would hide it behind a
 * plausible-looking selection.
 *
 * Mask clips live in the same `clips` array but are filtered out of the
 * rendered timeline, so the host can never select one; neither can an
 * extension.
 */
export function setExtensionTimelineClipSelection(
  clipIds: readonly string[],
): ExtensionSelectionResult {
  const state = useTimelineStore.getState();
  const unique: string[] = [];
  for (const clipId of clipIds) {
    if (unique.includes(clipId)) continue;
    const clip = state.clips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      return selectionFailure(
        "clip_not_found",
        `No clip with id "${clipId}" exists.`,
      );
    }
    if (clip.type === "mask") {
      return selectionFailure(
        "clip_not_selectable",
        `Clip "${clipId}" is a mask clip, which the timeline never selects.`,
      );
    }
    unique.push(clipId);
  }

  const before = state.selectedClipIds;
  const hadTransition = state.selectedTransitionId !== null;
  state.setSelectedClips(unique);
  const changed =
    hadTransition ||
    before.length !== unique.length ||
    before.some((clipId, index) => clipId !== unique[index]);
  return Object.freeze({ ok: true as const, changed });
}

/** Selects one transition, or clears the selection entirely with null. */
export function setExtensionTimelineTransitionSelection(
  transitionId: string | null,
): ExtensionSelectionResult {
  // Clearing goes through the clip path: the store's `selectTransition(null)`
  // leaves a clip selection standing, and the contract promises an empty
  // selection.
  if (transitionId === null) return setExtensionTimelineClipSelection([]);

  const state = useTimelineStore.getState();
  if (!state.transitions.some((transition) => transition.id === transitionId)) {
    return selectionFailure(
      "transition_not_found",
      `No transition with id "${transitionId}" exists.`,
    );
  }

  const changed =
    state.selectedTransitionId !== transitionId ||
    state.selectedClipIds.length > 0;
  state.selectTransition(transitionId);
  return Object.freeze({ ok: true as const, changed });
}

export function getExtensionTimelineTransitions(): readonly ExtensionTimelineTransitionSnapshot[] {
  return Object.freeze(
    useTimelineStore.getState().transitions.map(toExtensionTransitionSnapshot),
  );
}

export function getExtensionTimelineClipMasks(
  clipId: string,
): readonly ExtensionTimelineMaskSnapshot[] {
  return Object.freeze(
    selectMaskClipsForParent(useTimelineStore.getState(), clipId).map(
      toExtensionMaskSnapshot,
    ),
  );
}

export function getExtensionTimelineClipSnapshot(
  clipId: string,
): ExtensionTimelineClipSnapshot | null {
  const clip = getTimelineClipById(clipId);
  return clip ? toExtensionClipSnapshot(clip) : null;
}

export function commitExtensionTimelineTransaction(
  label: string,
  ownerId: string,
  commands: readonly ExtensionTimelineCommand[],
  options?: ExtensionTimelineTransactionOptions,
): ExtensionTimelineTransactionResult {
  return useTimelineStore
    .getState()
    .commitExtensionTransaction(label, ownerId, commands, options);
}

export function replaceTimelineSnapshot(
  snapshot: TimelineSnapshot | null,
): void {
  useTimelineStore.getState().replaceTimelineSnapshot(snapshot);
}

export function setTimelinePersistenceSuspended(suspended: boolean): void {
  useTimelineStore.getState().setTimelinePersistenceSuspended(suspended);
}

export function addTimelineClip(clip: TimelineClip): void {
  useTimelineStore.getState().addClip(clip);
}

export function createTimelineClipFromAsset(asset: Asset): BaseClip {
  return createClipFromAsset(asset);
}

export function insertTimelineBaseClipAtTime(
  baseClip: BaseClip,
  startTick: number,
): string | null {
  return insertBaseClipAtTime(baseClip, startTick);
}

export function insertTimelineAssetAtTime(asset: Asset, startTick: number): void {
  insertAssetAtTime(asset, startTick);
}

export function addTimelineClipsOnNewTracksBelow(
  sourceTrackId: string,
  entries: AddTimelineClipsOnNewTracksEntry[],
): string[] {
  return useTimelineStore
    .getState()
    .addClipsOnNewTracksBelow(sourceTrackId, entries);
}

export function groupTimelineClipsIntoComposite(
  sourceClipIds: string[],
  compositeClip: TimelineClip,
  extractionRange?: { start: number; end: number },
): boolean {
  return useTimelineStore
    .getState()
    .groupClipsIntoComposite(sourceClipIds, compositeClip, extractionRange);
}

export function syncTimelineCompositePlacementRevision(
  compositeId: string,
  compositeRevision: number,
  bakedAssetId?: string,
): void {
  useTimelineStore
    .getState()
    .syncCompositePlacementRevision(
      compositeId,
      compositeRevision,
      bakedAssetId,
    );
}

export function remapTimelineCompositePlacement(
  clipId: string,
  expectedCompositeId: string,
  compositeId: string,
  compositeRevision: number,
): boolean {
  return useTimelineStore
    .getState()
    .remapCompositePlacement(
      clipId,
      expectedCompositeId,
      compositeId,
      compositeRevision,
    );
}

export function removeTimelineClip(clipId: string): void {
  useTimelineStore.getState().removeClip(clipId);
}

export function removeTimelineClips(clipIds: string[]): boolean {
  return useTimelineStore.getState().removeClips(clipIds);
}

/**
 * Cut a clip in two. `splitTick` is stored track time — pair this with
 * {@link getTimelineSplitPointsAtPlayhead}, which converts the presentation
 * playhead into that domain.
 */
export function splitTimelineClip(clipId: string, splitTick: number): void {
  useTimelineStore.getState().splitClip(clipId, splitTick);
}

export function moveTimelineClips(
  moves: TimelineClipMove[],
  options?: Parameters<TimelineStoreState["moveClips"]>[1],
): boolean {
  return useTimelineStore.getState().moveClips(moves, options);
}

export function removeTimelineClipsByAssetId(assetId: string): number {
  return useTimelineStore.getState().removeClipsByAssetId(assetId);
}

export function replaceTimelineClipAsset(clipId: string, asset: Asset): void {
  useTimelineStore.getState().replaceClipAsset(clipId, asset);
}

export function toggleTimelineClipMute(clipId: string): void {
  useTimelineStore.getState().toggleClipMute(clipId);
}

export function updateTimelineClipShape(
  clipId: string,
  shape: TimelineClipShape,
): void {
  useTimelineStore.getState().updateClipShape(clipId, shape);
}

export function updateTimelineTextClipData(
  clipId: string,
  updates: Partial<TextClipData>,
): void {
  useTimelineStore.getState().updateTextClipData(clipId, updates);
}

export function addTimelineClipTransform(
  clipId: string,
  transform: ClipTransform,
): void {
  useTimelineStore.getState().addClipTransform(clipId, transform);
}

export function updateTimelineClipTransform(
  clipId: string,
  transformId: string,
  updates: UpdateTimelineClipTransformPayload,
): void {
  useTimelineStore.getState().updateClipTransform(clipId, transformId, updates);
}

export function setTimelineClipTransforms(
  clipId: string,
  transforms: ClipTransform[],
  options?: Parameters<TimelineStoreState["setClipTransforms"]>[2],
): void {
  if (options === undefined) {
    useTimelineStore.getState().setClipTransforms(clipId, transforms);
    return;
  }
  useTimelineStore.getState().setClipTransforms(clipId, transforms, options);
}

export function setTimelineClipTransformsAndShape(
  clipId: string,
  transforms: ClipTransform[],
  shape: TimelineClipShape,
): void {
  useTimelineStore
    .getState()
    .setClipTransformsAndShape(clipId, transforms, shape);
}

export function setTimelineClipMaskCompositeTransforms(
  clipId: string,
  transforms: ClipTransform[],
): void {
  useTimelineStore
    .getState()
    .setClipMaskCompositeTransforms(clipId, transforms);
}

export function removeTimelineClipTransform(
  clipId: string,
  transformId: string,
): void {
  useTimelineStore.getState().removeClipTransform(clipId, transformId);
}

export function addTimelineAdjustmentClip(
  input: Parameters<TimelineStoreState["addAdjustmentClip"]>[0],
): string | null {
  return useTimelineStore.getState().addAdjustmentClip(input);
}

export function setTimelineAdjustmentDepth(
  clipId: string,
  depth: AdjustmentDepth,
): boolean {
  return useTimelineStore.getState().setAdjustmentDepth(clipId, depth);
}

export function setTimelineAdjustmentRetimingMode(
  clipId: string,
  retimingMode: AdjustmentRetimingMode,
): boolean {
  return useTimelineStore
    .getState()
    .setAdjustmentRetimingMode(clipId, retimingMode);
}

export function selectTimelineClip(
  clipId: string | null,
  isMulti?: boolean,
): void {
  const { selectClip } = useTimelineStore.getState();
  if (isMulti === undefined) {
    selectClip(clipId);
    return;
  }
  selectClip(clipId, isMulti);
}

export function clearTimelineClipSelection(): void {
  selectTimelineClip(null);
}

export function selectTimelineTransition(transitionId: string | null): void {
  useTimelineStore.getState().selectTransition(transitionId);
}

export function addTimelineTransition(
  transition: Transition,
  options?: { incomingStart?: number },
): boolean {
  return useTimelineStore.getState().addTransition(transition, options);
}

export function updateTimelineTransitionParameters(
  transitionId: string,
  updates: Record<string, unknown>,
): boolean {
  return useTimelineStore
    .getState()
    .updateTransitionParameters(transitionId, updates);
}

export function addTimelineClipMask(clipId: string, mask: ClipMask): void {
  useTimelineStore.getState().addClipMask(clipId, mask);
}

export function duplicateTimelineClipMask(
  clipId: string,
  maskId: string,
): string | null {
  return useTimelineStore.getState().duplicateClipMask(clipId, maskId);
}

export function updateTimelineClipMask(
  clipId: string,
  maskId: string,
  updates: TimelineMaskUpdate,
): void {
  useTimelineStore.getState().updateClipMask(clipId, maskId, updates);
}

export function removeTimelineClipMask(
  clipId: string,
  maskId: string,
): void {
  useTimelineStore.getState().removeClipMask(clipId, maskId);
}

export function setTimelineClipMaskBooleanExpression(
  clipId: string,
  expression: MaskBooleanExpression | null,
): void {
  useTimelineStore
    .getState()
    .setClipMaskBooleanExpression(clipId, expression);
}

export function setTimelineClipMaskCompositionAlgebra(
  clipId: string,
  algebra: MaskCompositionAlgebra,
): void {
  useTimelineStore
    .getState()
    .setClipMaskCompositionAlgebra(clipId, algebra);
}

export function setTimelineClipMaskExpressionEnabled(
  clipId: string,
  enabled: boolean,
): void {
  useTimelineStore
    .getState()
    .setClipMaskExpressionEnabled(clipId, enabled);
}

export function addTimelineClipComponent(
  clipId: string,
  component: Component,
): void {
  useTimelineStore.getState().addClipComponent(clipId, component);
}

export function updateTimelineClipComponent(
  clipId: string,
  componentId: string,
  updater: UpdateTimelineClipComponentFn,
): void {
  useTimelineStore.getState().updateClipComponent(clipId, componentId, updater);
}

export function removeTimelineClipComponent(
  clipId: string,
  componentId: string,
): void {
  useTimelineStore.getState().removeClipComponent(clipId, componentId);
}

export async function flushPendingTimelinePersistence(): Promise<void> {
  await useTimelineStore.getState().flushPendingPersistence();
}

export type {
  AddTimelineClipsOnNewTracksEntry,
  ExtensionTimelineCommand,
  TimelineStoreState,
  UpdateTimelineClipComponentFn,
  UpdateTimelineClipTransformPayload,
};
export { createExtensionMaskLocalId } from "./model/extensionMaskOwnership";
