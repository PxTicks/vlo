import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  AssetBackedBaseClip,
  AssetBackedTimelineClip,
  TimelineClip,
} from "../../../types/TimelineTypes";
import {
  AudioAnalysisError,
  audioAnalysisService,
  isAudioAnalysisAbortError,
  useAsset,
  type AudioAnalysisReader,
  type AudioAnalysisWaveform,
} from "../../userAssets";
import { calculateClipTime } from "../../transformations";
import { tickToMediaSeconds } from "../../../core/time";
import { ticksPerPixel as ticksPerPixelAt } from "../../../core/time/pixelGrid";
import {
  waveformCacheService,
  WAVEFORM_BASE_SAMPLES_PER_PEAK,
  WAVEFORM_PEAKS_PER_BUCKET,
  type WaveformAssetMetadata,
} from "../services/WaveformCacheService";
import {
  clampWaveformAssetTickToFirstSample,
  resolveWaveformBucketRequestSeconds,
} from "../utils/waveformTiming";
import { useClipCanvasWindow } from "./useClipCanvasWindow";

interface UseWaveformRendererProps {
  audioAnalysis?: AudioAnalysisReader;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  clip: AssetBackedBaseClip | AssetBackedTimelineClip;
  zoomScale: number;
  height: number;
  enabled?: boolean;
  isDragging?: boolean;
  presentationStart?: number;
  presentationDuration?: number;
  mapPresentationOffsetToClipOffset?: (presentationOffset: number) => number;
}

interface UseWaveformRendererResult {
  showFallbackOverlay: boolean;
}

interface BucketRange {
  end: number;
  start: number;
}

interface MutableBucket {
  initialized: Uint8Array;
  max: Float32Array;
  min: Float32Array;
}

type WaveformStatus = "loading" | "ready" | "unavailable";

const INT16_MAX = 32767;
const INT16_MIN_ABS = 32768;
const WAVEFORM_FETCH_THROTTLE_MS = 250;
const WAVEFORM_FETCH_DEBOUNCE_MS = 100;
const WAVEFORM_BACKGROUND = "#102317";
const WAVEFORM_COLOR = "#7ef0a3";

function clampToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped < 0) {
    return Math.round(clamped * INT16_MIN_ABS);
  }
  return Math.round(clamped * INT16_MAX);
}

function int16ToAmplitude(value: number): number {
  if (value < 0) {
    return value / INT16_MIN_ABS;
  }
  return value / INT16_MAX;
}

function createMutableBucket(): MutableBucket {
  return {
    initialized: new Uint8Array(WAVEFORM_PEAKS_PER_BUCKET),
    max: new Float32Array(WAVEFORM_PEAKS_PER_BUCKET).fill(-1),
    min: new Float32Array(WAVEFORM_PEAKS_PER_BUCKET).fill(1),
  };
}

function finalizeMutableBucket(bucket: MutableBucket): Int16Array {
  const output = new Int16Array(WAVEFORM_PEAKS_PER_BUCKET * 2);

  for (let peakIndex = 0; peakIndex < WAVEFORM_PEAKS_PER_BUCKET; peakIndex++) {
    const offset = peakIndex * 2;
    if (bucket.initialized[peakIndex]) {
      output[offset] = clampToInt16(bucket.min[peakIndex]);
      output[offset + 1] = clampToInt16(bucket.max[peakIndex]);
      continue;
    }

    output[offset] = 0;
    output[offset + 1] = 0;
  }

  return output;
}

function groupContiguousIndices(indices: number[]): BucketRange[] {
  if (indices.length === 0) {
    return [];
  }

  const ranges: BucketRange[] = [];
  let rangeStart = indices[0]!;
  let previous = rangeStart;

  for (let i = 1; i < indices.length; i++) {
    const current = indices[i]!;
    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push({ start: rangeStart, end: previous });
    rangeStart = current;
    previous = current;
  }

  ranges.push({ start: rangeStart, end: previous });
  return ranges;
}

function getFramesPerPeak(
  level: number,
  metadata: WaveformAssetMetadata,
): number {
  return metadata.baseSamplesPerPeak * 2 ** level;
}

function resolveWaveformLevel(
  framesPerPixel: number,
  metadata: WaveformAssetMetadata,
): number {
  if (framesPerPixel <= metadata.baseSamplesPerPeak) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor(Math.log2(framesPerPixel / metadata.baseSamplesPerPeak)),
  );
}

function getAssetTickForPixel(
  clip: AssetBackedBaseClip | AssetBackedTimelineClip,
  pixelOffset: number,
  ticksPerPixel: number,
  firstTimestampSeconds?: number,
  mapPresentationOffsetToClipOffset?: (presentationOffset: number) => number,
): number {
  const presentationOffset = pixelOffset * ticksPerPixel;
  const clipOffset =
    mapPresentationOffsetToClipOffset?.(presentationOffset) ??
    presentationOffset;
  return clampWaveformAssetTickToFirstSample(
    calculateClipTime(clip as TimelineClip, clipOffset),
    firstTimestampSeconds,
  );
}

function ticksToSampleFrame(assetTick: number, sampleRate: number): number {
  return Math.max(0, Math.round(tickToMediaSeconds(assetTick) * sampleRate));
}

export function useWaveformRenderer({
  audioAnalysis,
  canvasRef,
  clip,
  zoomScale,
  height,
  enabled = true,
  isDragging = false,
  presentationStart,
  presentationDuration,
  mapPresentationOffsetToClipOffset,
}: UseWaveformRendererProps): UseWaveformRendererResult {
  const asset = useAsset(clip.assetId);
  const [waveformStatus, setWaveformStatus] =
    useState<WaveformStatus>("loading");
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingDrawRef = useRef(false);
  const throttleLastRunRef = useRef(0);
  const {
    clipStart,
    fullCanvasWidth,
    leftWingPx,
    scrollContainer,
    updateCanvasGeometry,
    updateViewportState,
  } = useClipCanvasWindow({
    canvasRef,
    clip,
    zoomScale,
    height,
    enabled,
    isDragging,
    presentationStart,
    presentationDuration,
  });
  const clipOffset = "offset" in clip ? (clip as TimelineClip).offset : 0;
  const clipSourceDuration =
    "sourceDuration" in clip ? (clip as TimelineClip).sourceDuration : 0;

  useEffect(() => {
    const assetId = clip.assetId;
    if (!assetId || !enabled) {
      return;
    }

    waveformCacheService.acquire(assetId);
    return () => {
      waveformCacheService.release(assetId);
    };
  }, [clip.assetId, enabled]);

  // Mirror cached bucket presence into status during render whenever the
  // active asset changes (or the renderer is re-enabled).
  const [lastStatusSyncKey, setLastStatusSyncKey] = useState<string>(
    `${enabled}|${clip.assetId ?? ""}`,
  );
  const currentStatusSyncKey = `${enabled}|${clip.assetId ?? ""}`;
  if (lastStatusSyncKey !== currentStatusSyncKey) {
    setLastStatusSyncKey(currentStatusSyncKey);
    if (enabled && clip.assetId) {
      setWaveformStatus(
        waveformCacheService.hasAnyBuckets(clip.assetId) ? "ready" : "loading",
      );
    }
  }

  const markWaveformReady = useCallback(() => {
    setWaveformStatus((current) => (current === "ready" ? current : "ready"));
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !clip.assetId) {
      return;
    }

    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) {
      return;
    }

    const metadata = waveformCacheService.getMetadata(clip.assetId);
    if (!metadata) {
      return;
    }

    const geometry = updateCanvasGeometry();
    if (!geometry) {
      return;
    }

    const { localStart, localWidth } = geometry;
    const ticksPerPixel = ticksPerPixelAt(zoomScale);

    ctx.fillStyle = WAVEFORM_BACKGROUND;
    ctx.fillRect(0, 0, localWidth, height);

    let foundAnyWaveform = false;
    ctx.fillStyle = WAVEFORM_COLOR;

    for (let localX = 0; localX < localWidth; localX++) {
      const globalX = localStart + localX;
      const pixelOffset = globalX - leftWingPx;
      const assetTick = getAssetTickForPixel(
        clip,
        pixelOffset,
        ticksPerPixel,
        metadata.firstTimestampSeconds,
        mapPresentationOffsetToClipOffset,
      );

      if (
        assetTick < 0 ||
        (clip.sourceDuration !== null && assetTick > clip.sourceDuration)
      ) {
        continue;
      }

      const nextAssetTick = getAssetTickForPixel(
        clip,
        pixelOffset + 1,
        ticksPerPixel,
        metadata.firstTimestampSeconds,
        mapPresentationOffsetToClipOffset,
      );
      const sourceFrame = ticksToSampleFrame(assetTick, metadata.sampleRate);
      const nextSourceFrame = ticksToSampleFrame(
        nextAssetTick,
        metadata.sampleRate,
      );
      const framesPerPixel = Math.max(
        1,
        Math.abs(nextSourceFrame - sourceFrame),
      );
      const level = resolveWaveformLevel(framesPerPixel, metadata);
      const peakIndex = Math.floor(
        sourceFrame / getFramesPerPeak(level, metadata),
      );
      const match = waveformCacheService.findClosestBucket(
        clip.assetId,
        level,
        peakIndex,
      );

      if (!match) {
        continue;
      }

      const bucketOffset = match.peakIndex * 2;
      const minAmplitude = int16ToAmplitude(match.bucket[bucketOffset] ?? 0);
      const maxAmplitude = int16ToAmplitude(
        match.bucket[bucketOffset + 1] ?? 0,
      );
      const barTop = Math.round(((1 - maxAmplitude) * height) / 2);
      const barBottom = Math.round(((1 - minAmplitude) * height) / 2);
      const barHeight = Math.max(1, barBottom - barTop);

      ctx.fillRect(localX, barTop, 1, barHeight);
      foundAnyWaveform = true;
    }

    if (foundAnyWaveform) {
      markWaveformReady();
    }
  }, [
    canvasRef,
    clip,
    height,
    leftWingPx,
    mapPresentationOffsetToClipOffset,
    markWaveformReady,
    updateCanvasGeometry,
    zoomScale,
  ]);

  // draw() paints into a canvas ref and may flip status to "ready" once
  // samples are visible. Drawing requires a committed DOM canvas, so it has
  // to live in a layout effect.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    updateCanvasGeometry();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    draw();
  }, [draw, enabled, updateCanvasGeometry]);

  useEffect(() => {
    if (!enabled || asset?.type !== "audio" || !clip.assetId) {
      return;
    }
    const analysis = audioAnalysis ?? audioAnalysisService;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const { signal } = abortController;

    const scheduleDraw = () => {
      if (pendingDrawRef.current) {
        return;
      }

      pendingDrawRef.current = true;
      requestAnimationFrame(() => {
        pendingDrawRef.current = false;
        draw();
      });
    };

    const ensureMetadata = async (): Promise<WaveformAssetMetadata | null> => {
      const cachedMetadata = waveformCacheService.getMetadata(clip.assetId!);
      if (cachedMetadata) {
        return cachedMetadata;
      }

      const source = await analysis.inspect(clip.assetId!, {
        signals: [signal],
      });
      if (source.durationSeconds <= 0) return null;
      const metadata: WaveformAssetMetadata = {
        sampleRate: source.sampleRate,
        numberOfChannels: source.numberOfChannels,
        durationSeconds: source.durationSeconds,
        firstTimestampSeconds: source.firstTimestampSeconds,
        endTimestampSeconds: source.endTimestampSeconds,
        baseSamplesPerPeak: WAVEFORM_BASE_SAMPLES_PER_PEAK,
        peaksPerBucket: WAVEFORM_PEAKS_PER_BUCKET,
      };

      waveformCacheService.setMetadata(clip.assetId!, metadata);
      return metadata;
    };

    const collectMissingBuckets = (
      metadata: WaveformAssetMetadata,
      localStart: number,
      localWidth: number,
    ): Map<number, Set<number>> => {
      const bucketsByLevel = new Map<number, Set<number>>();
      const ticksPerPixel = ticksPerPixelAt(zoomScale);

      for (let localX = 0; localX < localWidth; localX++) {
        const globalX = localStart + localX;
        const pixelOffset = globalX - leftWingPx;
        const assetTick = getAssetTickForPixel(
          clip,
          pixelOffset,
          ticksPerPixel,
          metadata.firstTimestampSeconds,
          mapPresentationOffsetToClipOffset,
        );

        if (
          assetTick < 0 ||
          (clip.sourceDuration !== null && assetTick > clip.sourceDuration)
        ) {
          continue;
        }

        const nextAssetTick = getAssetTickForPixel(
          clip,
          pixelOffset + 1,
          ticksPerPixel,
          metadata.firstTimestampSeconds,
          mapPresentationOffsetToClipOffset,
        );
        const sourceFrame = ticksToSampleFrame(assetTick, metadata.sampleRate);
        const nextSourceFrame = ticksToSampleFrame(
          nextAssetTick,
          metadata.sampleRate,
        );
        const framesPerPixel = Math.max(
          1,
          Math.abs(nextSourceFrame - sourceFrame),
        );
        const level = resolveWaveformLevel(framesPerPixel, metadata);
        const peakIndex = Math.floor(
          sourceFrame / getFramesPerPeak(level, metadata),
        );
        const bucketIndex = Math.floor(peakIndex / metadata.peaksPerBucket);

        if (
          !waveformCacheService.hasBucket(clip.assetId!, level, bucketIndex)
        ) {
          const bucketsAtLevel = bucketsByLevel.get(level) ?? new Set<number>();
          bucketsAtLevel.add(bucketIndex);
          bucketsByLevel.set(level, bucketsAtLevel);
        }
      }

      return bucketsByLevel;
    };

    const analyzeBucketRange = async (
      metadata: WaveformAssetMetadata,
      level: number,
      range: BucketRange,
    ): Promise<boolean> => {
      const framesPerPeak = getFramesPerPeak(level, metadata);
      const framesPerBucket = framesPerPeak * metadata.peaksPerBucket;
      const endFrameExclusive = (range.end + 1) * framesPerBucket;
      const mutableBuckets = new Map<number, MutableBucket>();
      const startSeconds = resolveWaveformBucketRequestSeconds(
        range.start,
        framesPerBucket,
        metadata.sampleRate,
        metadata.firstTimestampSeconds,
      );
      const endSeconds = endFrameExclusive / metadata.sampleRate;

      for (
        let bucketIndex = range.start;
        bucketIndex <= range.end;
        bucketIndex++
      ) {
        mutableBuckets.set(bucketIndex, createMutableBucket());
      }

      let waveform: AudioAnalysisWaveform | null = null;
      try {
        waveform = await analysis.readWaveform(clip.assetId!, {
          startSeconds,
          endSeconds,
          samplesPerPeak: framesPerPeak,
          peakOriginSeconds: 0,
          signals: [signal],
        });
      } catch (error) {
        if (isAudioAnalysisAbortError(error)) throw error;
        if (
          !(error instanceof AudioAnalysisError) ||
          (error.code !== "invalid_range" && error.code !== "decode_failed")
        ) {
          throw error;
        }
        // A terminal bucket may begin exactly at the source end. Preserve the
        // old renderer behaviour: cache silence for it and continue the pass.
      }

      const peakCount = waveform?.channels[0]?.min.length ?? 0;
      for (let localPeakIndex = 0; localPeakIndex < peakCount; localPeakIndex++) {
        const absolutePeakIndex = waveform!.firstPeakIndex + localPeakIndex;
        if (absolutePeakIndex < 0) continue;
        const bucketIndex = Math.floor(
          absolutePeakIndex / metadata.peaksPerBucket,
        );
        const bucket = mutableBuckets.get(bucketIndex);
        if (!bucket) continue;

        const peakIndex = absolutePeakIndex % metadata.peaksPerBucket;
        let peakMin = 1;
        let peakMax = -1;
        for (const channel of waveform!.channels) {
          peakMin = Math.min(peakMin, channel.min[localPeakIndex] ?? 0);
          peakMax = Math.max(peakMax, channel.max[localPeakIndex] ?? 0);
        }
        bucket.initialized[peakIndex] = 1;
        bucket.min[peakIndex] = peakMin;
        bucket.max[peakIndex] = peakMax;
      }

      let storedAnyBucket = false;

      for (
        let bucketIndex = range.start;
        bucketIndex <= range.end;
        bucketIndex++
      ) {
        const bucket = mutableBuckets.get(bucketIndex);
        if (!bucket || signal.aborted) {
          return false;
        }

        waveformCacheService.setBucket(
          clip.assetId!,
          level,
          bucketIndex,
          finalizeMutableBucket(bucket),
        );
        storedAnyBucket = true;
      }

      if (storedAnyBucket) {
        markWaveformReady();
      }

      return storedAnyBucket;
    };

    const generateWaveforms = async () => {
      updateViewportState();

      try {
        const metadata = await ensureMetadata();
        if (!metadata) {
          setWaveformStatus("unavailable");
          return;
        }

        const geometry = updateCanvasGeometry();
        if (!geometry) {
          return;
        }

        const missingBuckets = collectMissingBuckets(
          metadata,
          geometry.localStart,
          geometry.localWidth,
        );
        if (missingBuckets.size === 0) {
          if (waveformCacheService.hasAnyBuckets(clip.assetId!)) {
            markWaveformReady();
          }
          return;
        }

        const sortedLevels = Array.from(missingBuckets.keys()).sort(
          (a, b) => a - b,
        );

        for (const level of sortedLevels) {
          if (signal.aborted) {
            return;
          }

          const bucketIndices = Array.from(
            missingBuckets.get(level) ?? [],
          ).sort((a, b) => a - b);

          for (const range of groupContiguousIndices(bucketIndices)) {
            const stored = await analyzeBucketRange(
              metadata,
              level,
              range,
            );
            if (stored) {
              scheduleDraw();
            }
            if (signal.aborted) {
              return;
            }
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          console.warn(error);
          setWaveformStatus("unavailable");
        }
      }
    };

    void generateWaveforms();

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      if (isDragging) {
        return;
      }

      updateViewportState();
      requestAnimationFrame(draw);

      const now = Date.now();
      if (now - throttleLastRunRef.current > WAVEFORM_FETCH_THROTTLE_MS) {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        void generateWaveforms();
        throttleLastRunRef.current = now;
      } else {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          void generateWaveforms();
          throttleLastRunRef.current = Date.now();
        }, WAVEFORM_FETCH_DEBOUNCE_MS);
      }
    };

    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    }

    return () => {
      abortController.abort();
      pendingDrawRef.current = false;
      if (scrollContainer) {
        scrollContainer.removeEventListener("scroll", onScroll);
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    asset,
    audioAnalysis,
    clip.assetId,
    clip.transformations,
    clipOffset,
    clipSourceDuration,
    clipStart,
    draw,
    enabled,
    fullCanvasWidth,
    height,
    isDragging,
    leftWingPx,
    mapPresentationOffsetToClipOffset,
    scrollContainer,
    updateCanvasGeometry,
    updateViewportState,
    zoomScale,
  ]);

  return {
    showFallbackOverlay: enabled && waveformStatus !== "ready",
  };
}
