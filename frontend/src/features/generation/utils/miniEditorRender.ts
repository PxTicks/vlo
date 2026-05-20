import type { Asset } from "../../../types/Asset";
import type { RangeMaskComponent } from "../../../types/Components";
import type {
  TimelineSelection,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";
import type { ExportConfig, ProjectData } from "../../renderer";
import { TICKS_PER_SECOND, createClipFromAsset } from "../../timeline";
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

export interface MiniEditorRenderResult {
  /** Cropped video (full frames; range masks are NOT burned in — mp4 has no alpha). */
  video: File;
  /**
   * Mask matte aligned to the cropped video, or null when the input carries no
   * mask and no active range masks were added.
   */
  mask: File | null;
}

interface EditedRenderInputs {
  exportConfig: ExportConfig;
  projectData: ProjectData;
  selection: TimelineSelection;
}

interface SingleClipRenderParams {
  /** Source video (the editable footage, or an existing mask matte). */
  videoUrl: string;
  videoFile: File;
  /** Full source duration in ticks. */
  durationTicks: number;
  cropStartTicks: number;
  cropEndTicks: number;
  ranges: EditorRangeMask[];
  dims: { width: number; height: number };
  backgroundColor?: number;
  backgroundAlpha?: number;
}

function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Builds an in-memory single-track, single-clip project: a synthetic video
 * asset pointing at the given source, a clip trimmed to the crop window, and
 * range_mask components for the masked time windows. Nothing here touches the
 * global timeline / asset stores.
 */
function buildSingleClipRenderInputs(
  params: SingleClipRenderParams,
): EditedRenderInputs {
  const durationTicks = Math.max(0, Math.round(params.durationTicks));
  const cropStart = Math.max(0, Math.min(params.cropStartTicks, durationTicks));
  const cropEnd = Math.max(
    cropStart,
    Math.min(params.cropEndTicks, durationTicks),
  );
  const cropLen = Math.max(1, cropEnd - cropStart);

  const asset: Asset = {
    id: `mini_editor_source_${crypto.randomUUID()}`,
    hash: "mini-editor-source",
    name: params.videoFile.name || "edited-video",
    type: "video",
    src: params.videoUrl,
    file: params.videoFile,
    duration: durationTicks / TICKS_PER_SECOND,
    createdAt: Date.now(),
  };

  const baseClip = createClipFromAsset(asset);
  const components: RangeMaskComponent[] = params.ranges.map((range) => ({
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

  const outputWidth = toEven(params.dims.width);
  const outputHeight = toEven(params.dims.height);
  const exportConfig: ExportConfig = {
    logicalWidth: params.dims.width,
    logicalHeight: params.dims.height,
    outputWidth,
    outputHeight,
    backgroundAlpha: params.backgroundAlpha ?? 0,
    backgroundColor: params.backgroundColor ?? 0x000000,
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

/**
 * Composites the new range masks onto an existing (transparency-derived) mask
 * matte without re-deriving it: the original matte plays as a clip over a WHITE
 * background, and each active range_mask drops the clip to alpha 0 for its
 * window — revealing white. This is a per-frame OR (range windows force the
 * whole frame to "masked"/white; elsewhere the original matte is preserved),
 * cropped to the same window as the edited video so the two stay aligned.
 */
async function renderCompositeMask(
  originalMaskFile: File,
  spec: MiniEditorEditSpec,
  maskDurationTicks: number,
  dims: { width: number; height: number },
  options: { signal?: AbortSignal } = {},
): Promise<File> {
  const maskUrl = URL.createObjectURL(originalMaskFile);
  try {
    const { exportConfig, projectData, selection } = buildSingleClipRenderInputs(
      {
        videoUrl: maskUrl,
        videoFile: originalMaskFile,
        durationTicks: maskDurationTicks,
        cropStartTicks: spec.cropStartTicks,
        cropEndTicks: spec.cropEndTicks,
        ranges: spec.ranges,
        dims,
        backgroundColor: 0xffffff,
        backgroundAlpha: 1,
      },
    );
    // Normal video output; range_mask alpha=0 reveals the white background.
    const file = await renderTimelineSelectionToMp4(selection, {
      includeTimelineMasks: true,
      signal: options.signal,
      renderInputs: { exportConfig, projectData },
    });
    return new File([file], `mini-editor-mask-${Date.now()}.mp4`, {
      type: "video/mp4",
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(maskUrl);
  }
}

/**
 * Bakes the mini-editor's edit into the files the generation pipeline consumes.
 *
 * - `video`: the source cropped to the trim window (full frames; mp4 has no
 *   alpha so range masks are never burned into the video channel).
 * - `mask`:
 *     • when the input already carried a mask (`originalMaskFile`), the original
 *       matte cropped to the window and OR'd with the new range windows;
 *     • otherwise, a binary matte from the new range masks (or null if none).
 */
export async function renderMiniEditorOutputs(
  spec: MiniEditorEditSpec,
  source: ResolvedEditorSource,
  dims: { width: number; height: number },
  options: { originalMaskFile?: File | null; signal?: AbortSignal } = {},
): Promise<MiniEditorRenderResult> {
  const { signal, originalMaskFile } = options;
  const inputs = buildSingleClipRenderInputs({
    videoUrl: source.videoUrl,
    videoFile: source.videoFile,
    durationTicks: source.durationTicks,
    cropStartTicks: spec.cropStartTicks,
    cropEndTicks: spec.cropEndTicks,
    ranges: spec.ranges,
    dims,
  });
  const renderInputs = { exportConfig: inputs.exportConfig, projectData: inputs.projectData };

  const activeRanges = spec.ranges.filter(
    (range) => range.isActive && range.endSourceTicks > range.startSourceTicks,
  );

  // Input already had a derived mask: crop it and OR the new ranges in. The
  // edited video keeps full frames.
  if (originalMaskFile) {
    const video = await renderTimelineSelectionToMp4(inputs.selection, {
      includeTimelineMasks: false,
      signal,
      renderInputs,
    });
    const mask = await renderCompositeMask(
      originalMaskFile,
      spec,
      source.durationTicks,
      dims,
      { signal },
    );
    return { video, mask };
  }

  // No pre-existing mask: range masks (if any) become a fresh binary matte.
  if (activeRanges.length === 0) {
    const video = await renderTimelineSelectionToMp4(inputs.selection, {
      includeTimelineMasks: false,
      signal,
      renderInputs,
    });
    return { video, mask: null };
  }

  const { video, mask } = await renderTimelineSelectionToMp4WithMask(
    inputs.selection,
    "binary",
    { signal, renderInputs },
  );
  return { video, mask };
}

