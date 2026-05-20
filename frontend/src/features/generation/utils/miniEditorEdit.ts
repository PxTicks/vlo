import type { Asset } from "../../../types/Asset";
import type { RangeMaskComponent } from "../../../types/Components";
import type {
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import type { ExportConfig, ProjectData } from "../../renderer";
import { TICKS_PER_SECOND, createClipFromAsset } from "../../timeline";
import { calculateClipTime } from "../../transformations";
import { getTicksPerFrame, snapTickToFrame } from "../../timelineSelection";
import { useProjectStore } from "../../project";
import type {
  EditorRangeMask,
  ResolvedEditorSource,
  MiniEditorEditSpec,
} from "../../miniEditor";
import {
  renderTimelineSelectionToMp4,
  renderTimelineSelectionToMp4WithMask,
} from "./inputSelection";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Maps a global timeline tick into a clip's source-tick domain (post-speed,
 * reversal-aware), clamped to the clip's visible extent. Mirrors the masks
 * feature's `toClipInputTimeTicks` but avoids a generation -> masks edge.
 */
function toClipInputTimeTicks(clip: TimelineClip, globalTimeTicks: number): number {
  const clamped = clamp(
    globalTimeTicks,
    clip.start,
    clip.start + clip.timelineDuration,
  );
  const localVisualTicks = clamped - clip.start;
  return Math.max(0, calculateClipTime(clip, localVisualTicks, true));
}

/**
 * Adds range_mask components to every clip that intersects each active range.
 *
 * Ranges are expressed in editor-local ticks (0 == the start of the rendered
 * selection); `selectionStartTicks` shifts them back onto the global timeline.
 * For each clip we intersect the global range with the clip's visible extent
 * and convert the overlap into the clip's source-tick domain via
 * `toClipInputTimeTicks` — which clamps to the clip's bounds, so a range that
 * straddles a clip edge (or overruns the clip) is split cleanly across the
 * clips it touches rather than producing an out-of-range window.
 *
 * The function is non-mutating: clips that gain a mask are returned as fresh
 * objects with a new components array; untouched clips are returned as-is.
 */
export function addRangeMasksToClips(
  clips: TimelineClip[],
  ranges: EditorRangeMask[],
  selectionStartTicks: number,
): TimelineClip[] {
  const activeRanges = ranges.filter(
    (range) => range.isActive && range.endSourceTicks > range.startSourceTicks,
  );
  if (activeRanges.length === 0) {
    return clips;
  }

  return clips.map((clip) => {
    // Spatial mask clips carry no range_mask; audio is not part of the visual
    // matte, so masking it would be a no-op.
    if (clip.type === "mask" || clip.type === "audio") {
      return clip;
    }

    const clipStart = clip.start;
    const clipEnd = clip.start + clip.timelineDuration;
    const newComponents: RangeMaskComponent[] = [];

    for (const range of activeRanges) {
      const globalStart = selectionStartTicks + range.startSourceTicks;
      const globalEnd = selectionStartTicks + range.endSourceTicks;
      const overlapStart = Math.max(clipStart, globalStart);
      const overlapEnd = Math.min(clipEnd, globalEnd);
      if (overlapEnd <= overlapStart) {
        continue;
      }

      const a = toClipInputTimeTicks(clip, overlapStart);
      const b = toClipInputTimeTicks(clip, overlapEnd);
      const startSourceTicks = Math.round(Math.min(a, b));
      const endSourceTicks = Math.round(Math.max(a, b));
      if (endSourceTicks <= startSourceTicks) {
        continue;
      }

      newComponents.push({
        id: `range_${crypto.randomUUID()}`,
        type: "range_mask",
        parameters: { startSourceTicks, endSourceTicks, isActive: true },
      });
    }

    if (newComponents.length === 0) {
      return clip;
    }

    return {
      ...clip,
      components: [...(clip.components ?? []), ...newComponents],
    };
  });
}

/**
 * Derives a new, true TimelineSelection from the one already attached to a
 * generation video input:
 *  - the crop window narrows the selection's [start, end];
 *  - range masks are written as range_mask components onto the intersecting
 *    clips (a non-mutating edit of the stored selection's clips).
 *
 * The result renders through the normal selection pipeline, so the original
 * timeline masks, transforms and metadata are preserved and the derived mask
 * is recomputed from real transparency — no baked-in re-render or mask OR.
 */
export function buildEditedTimelineSelection(
  source: TimelineSelection,
  spec: MiniEditorEditSpec,
): TimelineSelection {
  const base = source.start;
  const sourceDuration = Math.max(0, (source.end ?? base) - base);

  const fps =
    typeof source.fps === "number" && source.fps > 0 ? source.fps : null;
  const ticksPerFrame = fps ? getTicksPerFrame(fps) : null;
  const snap = (tick: number) =>
    ticksPerFrame ? snapTickToFrame(tick, ticksPerFrame) : tick;

  const cropStart = clamp(spec.cropStartTicks, 0, sourceDuration);
  const cropEnd = clamp(spec.cropEndTicks, cropStart, sourceDuration);
  const newStart = base + snap(cropStart);
  const newEnd = Math.max(newStart + 1, base + snap(cropEnd));

  const clips = addRangeMasksToClips(source.clips, spec.ranges, base);

  return {
    ...source,
    start: newStart,
    end: newEnd,
    clips,
  };
}

interface EditedRenderInputs {
  exportConfig: ExportConfig;
  projectData: ProjectData;
  selection: TimelineSelection;
}

export interface SyntheticEditedRenderResult {
  /** Cropped video (full frames; mp4 has no alpha so masks live in the matte). */
  video: File;
  /** Binary matte for the masked time windows, or null when no active ranges. */
  mask: File | null;
}

function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Builds an in-memory single-track, single-clip project for an editable video
 * *asset* (one that is not backed by the timeline): a synthetic video asset
 * trimmed to the crop window with range_mask components for the masked
 * windows. Used only for the asset path, where there is no real selection to
 * rebuild. Touches no global store.
 */
function buildSyntheticRenderInputs(
  spec: MiniEditorEditSpec,
  source: ResolvedEditorSource,
  dims: { width: number; height: number },
): EditedRenderInputs {
  const durationTicks = Math.max(0, Math.round(source.durationTicks));
  const cropStart = clamp(spec.cropStartTicks, 0, durationTicks);
  const cropEnd = clamp(spec.cropEndTicks, cropStart, durationTicks);
  const cropLen = Math.max(1, cropEnd - cropStart);

  const asset: Asset = {
    id: `mini_editor_source_${crypto.randomUUID()}`,
    hash: "mini-editor-source",
    name: source.videoFile.name || "edited-video",
    type: "video",
    src: source.videoUrl,
    file: source.videoFile,
    duration: durationTicks / TICKS_PER_SECOND,
    createdAt: Date.now(),
  };

  const baseClip = createClipFromAsset(asset);
  // The synthetic clip plays the asset's own timebase, so range ticks (which
  // are editor-local / asset-relative) are already in the clip's source domain.
  const components: RangeMaskComponent[] = spec.ranges.map((range) => ({
    id: range.id,
    type: "range_mask",
    parameters: {
      startSourceTicks: Math.round(range.startSourceTicks),
      endSourceTicks: Math.round(range.endSourceTicks),
      isActive: range.isActive,
    },
  }));

  const clip: VideoTimelineClip = {
    ...baseClip,
    type: "video",
    assetId: asset.id,
    trackId: "mini_editor_track",
    start: 0,
    offset: cropStart,
    sourceDuration: durationTicks,
    timelineDuration: cropLen,
    croppedSourceDuration: cropLen,
    transformedOffset: cropStart,
    transformedDuration: durationTicks,
    components,
  };

  const track: TimelineTrack = {
    id: "mini_editor_track",
    type: "visual",
    label: "Video",
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };

  const exportConfig: ExportConfig = {
    logicalWidth: dims.width,
    logicalHeight: dims.height,
    outputWidth: toEven(dims.width),
    outputHeight: toEven(dims.height),
    backgroundAlpha: 0,
  };

  const fps = Math.max(1, useProjectStore.getState().config.fps);
  const projectData: ProjectData = {
    tracks: [track],
    clips: [clip],
    assets: [asset],
    duration: cropLen,
    fps,
  };

  const selection: TimelineSelection = {
    start: 0,
    end: cropLen,
    clips: [clip],
    tracks: [track],
    fps,
  };

  return { exportConfig, projectData, selection };
}

/**
 * Bakes an edit of a plain video asset (no backing timeline selection) into the
 * files the generation pipeline consumes: a cropped video plus, when ranges are
 * present, a binary matte derived from their transparency.
 */
export async function renderSyntheticEditedOutputs(
  spec: MiniEditorEditSpec,
  source: ResolvedEditorSource,
  dims: { width: number; height: number },
  options: { signal?: AbortSignal } = {},
): Promise<SyntheticEditedRenderResult> {
  const { exportConfig, projectData, selection } = buildSyntheticRenderInputs(
    spec,
    source,
    dims,
  );
  const renderInputs = { exportConfig, projectData };

  const activeRanges = spec.ranges.filter(
    (range) => range.isActive && range.endSourceTicks > range.startSourceTicks,
  );

  if (activeRanges.length === 0) {
    const video = await renderTimelineSelectionToMp4(selection, {
      includeTimelineMasks: false,
      signal: options.signal,
      renderInputs,
    });
    return { video, mask: null };
  }

  const { video, mask } = await renderTimelineSelectionToMp4WithMask(
    selection,
    "binary",
    { signal: options.signal, renderInputs },
  );
  return { video, mask };
}

/** Loads enough of a video URL to read its duration, in timeline ticks. */
export async function probeVideoDurationTicks(videoUrl: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const seconds = Number.isFinite(video.duration) ? video.duration : 0;
      resolve(Math.max(0, Math.round(seconds * TICKS_PER_SECOND)));
    };
    video.onerror = () => reject(new Error("Could not read video metadata"));
    video.src = videoUrl;
  });
}

/** Captures a single frame of a video URL as a PNG File (used for slot thumbnails). */
export async function captureVideoFrameFile(
  videoUrl: string,
  atSeconds: number,
  filename: string,
): Promise<File> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = videoUrl;

  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("Could not load video for thumbnail"));
  });

  await new Promise<void>((resolve) => {
    video.onseeked = () => resolve();
    const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : 0;
    video.currentTime = Math.min(Math.max(0, atSeconds), max);
  });

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 320;
  canvas.height = video.videoHeight || 180;
  const ctx = canvas.getContext("2d");
  ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) {
    throw new Error("Could not encode video thumbnail");
  }
  return new File([blob], filename, { type: "image/png", lastModified: Date.now() });
}
