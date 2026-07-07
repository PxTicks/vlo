import type {
  ExtensionAssetApi,
  ExtensionEntityAssetSnapshot,
  ExtensionTimelineApi,
  ExtensionTimelineClipSnapshot,
  ExtensionTimelineMaskSnapshot,
  ExtensionTimelineTransformSnapshot,
  JsonValue,
} from "../../extensions/types";
import type {
  PositionParams,
  PositionPathParameter,
  RotationParams,
  ScaleParams,
} from "../../transformations/types";
import { samplePositionPath } from "../../transformations/utils/positionPath";
import { resolveScalar } from "../../transformations/utils/resolveScalar";
import {
  createBoundingBoxFromMaskPixels,
  createBoundingBoxFromPoints,
  getBoundingBoxCorners,
  getBoundingBoxCentroid,
  transformBoundingBox,
} from "../../tracking/utils/bounds";
import type {
  BoundingBox,
  CentroidTrackingSample,
} from "../../tracking/types";
import type { MaskLayoutState } from "../model/maskFactory";
import { createCentroidStabilizedPath } from "../../tracking/utils/centroidPath";

const DEFAULT_TRACKING_SAMPLE_COUNT = 24;
const MASK_PIXEL_THRESHOLD = 0;

interface DecodedMaskFrame {
  imageData: ImageData;
  width: number;
  height: number;
}

interface MaskFrameSampler {
  sample(timeSeconds: number): Promise<DecodedMaskFrame | null>;
  dispose(): void;
}

export interface MaskTrackingPathOptions {
  sampleCount?: number;
  spatialEpsilon?: number;
  simplifyEpsilon?: number;
}

export type MaskTrackingTimelineApi = Pick<
  ExtensionTimelineApi,
  | "ticksPerSecond"
  | "listClips"
  | "clipProgressToSourceTicks"
  | "sourcePointToProject"
>;

export type MaskTrackingAssetApi = Pick<
  ExtensionAssetApi,
  "get" | "readBlob"
>;

function readFiniteNumber(
  parameters: Readonly<Record<string, JsonValue>>,
  key: string,
  fallback: number,
): number {
  const value = parameters[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getStaticMaskLocalBox(
  mask: ExtensionTimelineMaskSnapshot,
): BoundingBox | null {
  const baseWidth = Math.max(1, readFiniteNumber(mask.parameters, "baseWidth", 1));
  const baseHeight = Math.max(
    1,
    readFiniteNumber(mask.parameters, "baseHeight", 1),
  );

  if (mask.maskType === "brush") {
    const bounds = mask.paintedBounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }
    return {
      x: bounds.x - baseWidth / 2,
      y: bounds.y - baseHeight / 2,
      width: bounds.width,
      height: bounds.height,
    };
  }

  if (
    mask.maskType === "rectangle" ||
    mask.maskType === "circle" ||
    mask.maskType === "triangle"
  ) {
    return {
      x: -baseWidth / 2,
      y: -baseHeight / 2,
      width: baseWidth,
      height: baseHeight,
    };
  }

  return null;
}

function maskTimeIsActive(
  mask: ExtensionTimelineMaskSnapshot,
  sourceTimeTicks: number,
): boolean {
  const activeRange = mask.activeRange;
  if (!activeRange) return true;
  return (
    sourceTimeTicks >= activeRange.startSourceTicks &&
    sourceTimeTicks <= activeRange.endSourceTicks
  );
}

function resolveWorldBox(
  localBox: BoundingBox,
  layout: MaskLayoutState,
): BoundingBox | null {
  return transformBoundingBox(localBox, {
    x: layout.x,
    y: layout.y,
    scaleX: layout.scaleX,
    scaleY: layout.scaleY,
    rotation: layout.rotation,
  });
}

function findTransform(
  transforms: readonly ExtensionTimelineTransformSnapshot[] | undefined,
  type: "position" | "scale" | "rotation",
): ExtensionTimelineTransformSnapshot | null {
  return transforms?.find((transform) => transform.type === type) ?? null;
}

function resolveMaskLayoutAtTime(
  mask: ExtensionTimelineMaskSnapshot,
  rawTimeTicks: number,
): MaskLayoutState {
  const transforms = mask.transformations ?? [];
  const positionTransform = findTransform(transforms, "position");
  const scaleTransform = findTransform(transforms, "scale");
  const rotationTransform = findTransform(transforms, "rotation");
  const positionParams = positionTransform?.parameters as unknown as
    | PositionParams
    | undefined;
  const activePath = positionParams?.extensionPath ?? positionParams?.path;
  const sampledPosition = activePath
    ? samplePositionPath(activePath, rawTimeTicks, mask.durationTicks)
    : null;
  const scaleParams = scaleTransform?.parameters as unknown as
    | ScaleParams
    | undefined;
  const rotationParams = rotationTransform?.parameters as unknown as
    | RotationParams
    | undefined;

  return {
    x:
      positionTransform && positionTransform.isEnabled !== false
        ? sampledPosition?.x ??
          resolveScalar(positionParams?.x ?? 0, rawTimeTicks, 0)
        : 0,
    y:
      positionTransform && positionTransform.isEnabled !== false
        ? sampledPosition?.y ??
          resolveScalar(positionParams?.y ?? 0, rawTimeTicks, 0)
        : 0,
    scaleX:
      scaleTransform && scaleTransform.isEnabled !== false
        ? resolveScalar(scaleParams?.x ?? 1, rawTimeTicks, 1)
        : 1,
    scaleY:
      scaleTransform && scaleTransform.isEnabled !== false
        ? resolveScalar(scaleParams?.y ?? 1, rawTimeTicks, 1)
        : 1,
    rotation:
      rotationTransform && rotationTransform.isEnabled !== false
        ? resolveScalar(rotationParams?.angle ?? 0, rawTimeTicks, 0)
        : 0,
  };
}

function createFrameCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Mask tracking could not create a canvas context.");
  }
  return context;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Mask tracking could not load the mask image."));
  });
  image.src = src;
  return loaded;
}

async function loadVideoMetadata(src: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  const loaded = new Promise<HTMLVideoElement>((resolve, reject) => {
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () =>
      reject(new Error("Mask tracking could not load the mask video."));
  });
  video.src = src;
  video.load();
  return loaded;
}

function createBlobObjectUrl(blob: Blob): string {
  if (typeof URL.createObjectURL !== "function") {
    throw new Error("Mask tracking could not create a mask asset URL.");
  }
  return URL.createObjectURL(blob);
}

function waitForSeek(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Mask tracking timed out while seeking the mask video."));
    }, 5000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Mask tracking could not seek the mask video."));
    };

    video.addEventListener("seeked", handleSeeked, { once: true });
    video.addEventListener("error", handleError, { once: true });
    video.currentTime = timeSeconds;
  });
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Mask tracking timed out while loading a mask frame."));
    }, 5000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", handleLoaded);
      video.removeEventListener("canplay", handleLoaded);
      video.removeEventListener("error", handleError);
    };
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Mask tracking could not load a mask frame."));
    };

    video.addEventListener("loadeddata", handleLoaded, { once: true });
    video.addEventListener("canplay", handleLoaded, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

async function createImageSampler(blob: Blob): Promise<MaskFrameSampler> {
  const objectUrl = createBlobObjectUrl(blob);
  const image = await loadImage(objectUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = createFrameCanvas(width, height);
  const context = get2dContext(canvas);

  return {
    sample: async () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return {
        width: canvas.width,
        height: canvas.height,
        imageData: context.getImageData(0, 0, canvas.width, canvas.height),
      };
    },
    dispose: () => URL.revokeObjectURL(objectUrl),
  };
}

async function createVideoSampler(blob: Blob): Promise<MaskFrameSampler> {
  const objectUrl = createBlobObjectUrl(blob);
  const video = await loadVideoMetadata(objectUrl);
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = createFrameCanvas(width, height);
  const context = get2dContext(canvas);

  return {
    sample: async (timeSeconds) => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const targetTime =
        duration > 0 ? Math.max(0, Math.min(duration, timeSeconds)) : 0;
      if (Math.abs(video.currentTime - targetTime) > 0.001) {
        await waitForSeek(video, targetTime);
      }
      await waitForVideoFrame(video);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return {
        width: canvas.width,
        height: canvas.height,
        imageData: context.getImageData(0, 0, canvas.width, canvas.height),
      };
    },
    dispose: () => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    },
  };
}

async function createAssetSampler(
  asset: ExtensionEntityAssetSnapshot,
  blob: Blob,
): Promise<MaskFrameSampler> {
  return asset.type === "video"
    ? createVideoSampler(blob)
    : createImageSampler(blob);
}

function imageFrameToProjectMaskBox(
  frame: DecodedMaskFrame,
  timeline: Pick<ExtensionTimelineApi, "sourcePointToProject">,
): BoundingBox | null {
  const coverageBox = createBoundingBoxFromMaskPixels(
    frame.imageData.data,
    frame.width,
    frame.height,
    { channel: "red", threshold: MASK_PIXEL_THRESHOLD },
  );
  if (!coverageBox) {
    return null;
  }

  return createBoundingBoxFromPoints(
    getBoundingBoxCorners(coverageBox).map((point) =>
      timeline.sourcePointToProject(point, {
        width: frame.width,
        height: frame.height,
      }),
    ),
  );
}

function createSampleProgresses(sampleCount: number): number[] {
  const count = Math.max(2, Math.round(sampleCount));
  return Array.from({ length: count }, (_entry, index) =>
    count === 1 ? 0 : index / (count - 1),
  );
}

async function collectAssetMaskSamples(
  clip: ExtensionTimelineClipSnapshot,
  mask: ExtensionTimelineMaskSnapshot,
  asset: ExtensionEntityAssetSnapshot,
  assetBlob: Blob,
  timeline: MaskTrackingTimelineApi,
  options: Required<Pick<MaskTrackingPathOptions, "sampleCount">>,
): Promise<CentroidTrackingSample[]> {
  const sampler = await createAssetSampler(asset, assetBlob);
  const samples: CentroidTrackingSample[] = [];

  try {
    for (const progress of createSampleProgresses(options.sampleCount)) {
      const visualTimeTicks = progress * clip.durationTicks;
      const sourceTimeTicks = timeline.clipProgressToSourceTicks(clip.id, progress);
      if (!maskTimeIsActive(mask, sourceTimeTicks)) {
        continue;
      }
      const frame = await sampler.sample(sourceTimeTicks / timeline.ticksPerSecond);
      if (!frame) {
        continue;
      }
      const localBox = imageFrameToProjectMaskBox(frame, timeline);
      if (!localBox) {
        continue;
      }
      const layout = resolveMaskLayoutAtTime(mask, visualTimeTicks);
      const worldBox = resolveWorldBox(localBox, layout);
      if (!worldBox) {
        continue;
      }
      samples.push({
        time: visualTimeTicks,
        position: { x: 0, y: 0 },
        centroid: getBoundingBoxCentroid(worldBox),
      });
    }
  } finally {
    sampler.dispose();
  }

  return samples;
}

function collectStaticMaskSamples(
  clip: ExtensionTimelineClipSnapshot,
  mask: ExtensionTimelineMaskSnapshot,
  timeline: MaskTrackingTimelineApi,
  options: Required<Pick<MaskTrackingPathOptions, "sampleCount">>,
): CentroidTrackingSample[] {
  const localBox = getStaticMaskLocalBox(mask);
  if (!localBox) {
    return [];
  }

  return createSampleProgresses(options.sampleCount).flatMap((progress) => {
    const visualTimeTicks = progress * clip.durationTicks;
    const sourceTimeTicks = timeline.clipProgressToSourceTicks(clip.id, progress);
    if (!maskTimeIsActive(mask, sourceTimeTicks)) {
      return [];
    }
    const layout = resolveMaskLayoutAtTime(mask, visualTimeTicks);
    const worldBox = resolveWorldBox(localBox, layout);
    if (!worldBox) {
      return [];
    }
    return [
      {
        time: visualTimeTicks,
        position: { x: 0, y: 0 },
        centroid: getBoundingBoxCentroid(worldBox),
      },
    ];
  });
}

export function canCreateTrackingPathFromMask(
  mask: ExtensionTimelineMaskSnapshot,
  assets: Pick<MaskTrackingAssetApi, "get">,
): boolean {
  const staticBox = getStaticMaskLocalBox(mask);
  if (staticBox) return true;
  const asset = mask.assetId ? assets.get(mask.assetId) : undefined;
  return !!asset && asset.type !== "audio";
}

function requireClipSnapshot(
  timeline: Pick<ExtensionTimelineApi, "listClips">,
  clipId: string,
): ExtensionTimelineClipSnapshot {
  const clip = timeline.listClips().find((candidate) => candidate.id === clipId);
  if (!clip) {
    throw new Error(`Timeline clip '${clipId}' was not found.`);
  }
  return clip;
}

export async function createPositionPathFromMaskTracking(options: {
  timeline: MaskTrackingTimelineApi;
  assets: MaskTrackingAssetApi;
  clipId: string;
  mask: ExtensionTimelineMaskSnapshot;
  tracking?: MaskTrackingPathOptions;
}): Promise<PositionPathParameter | null> {
  const sampleOptions = {
    sampleCount:
      options.tracking?.sampleCount ?? DEFAULT_TRACKING_SAMPLE_COUNT,
  };
  const clip = requireClipSnapshot(options.timeline, options.clipId);
  const asset = options.mask.assetId
    ? options.assets.get(options.mask.assetId)
    : undefined;
  const samples =
    asset && options.mask.assetId
      ? await collectAssetMaskSamples(
          clip,
          options.mask,
          asset,
          await options.assets.readBlob(options.mask.assetId),
          options.timeline,
          sampleOptions,
        )
      : collectStaticMaskSamples(
          clip,
          options.mask,
          options.timeline,
          sampleOptions,
        );

  return createCentroidStabilizedPath(samples, {
    spatialEpsilon: options.tracking?.spatialEpsilon ?? 2,
    simplifyEpsilon: options.tracking?.simplifyEpsilon ?? 1,
  });
}
