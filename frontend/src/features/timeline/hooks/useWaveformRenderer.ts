import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BaseClip, TimelineClip } from "../../../types/TimelineTypes";
import { getAssetInput, useAsset } from "../../userAssets";
import { calculateClipTime } from "../../transformations";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../constants";
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
import { AudioSampleSink } from "mediabunny";

interface UseWaveformRendererProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  clip: BaseClip;
  zoomScale: number;
  height: number;
  enabled?: boolean;
  isDragging?: boolean;
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

function getFramesPerPeak(level: number, metadata: WaveformAssetMetadata): number {
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
  clip: BaseClip,
  pixelOffset: number,
  ticksPerPixel: number,
  firstTimestampSeconds?: number,
): number {
  return clampWaveformAssetTickToFirstSample(
    calculateClipTime(clip as TimelineClip, pixelOffset * ticksPerPixel),
    firstTimestampSeconds,
  );
}

function ticksToSampleFrame(assetTick: number, sampleRate: number): number {
  return Math.max(
    0,
    Math.round((assetTick / TICKS_PER_SECOND) * sampleRate),
  );
}

export function useWaveformRenderer({
  canvasRef,
  clip,
  zoomScale,
  height,
  enabled = true,
  isDragging = false,
}: UseWaveformRendererProps): UseWaveformRendererResult {
  const asset = useAsset(clip.assetId);
  const [waveformStatus, setWaveformStatus] = useState<WaveformStatus>("loading");
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

  useEffect(() => {
    if (!enabled || !clip.assetId) {
      return;
    }

    setWaveformStatus(
      waveformCacheService.hasAnyBuckets(clip.assetId) ? "ready" : "loading",
    );
  }, [clip.assetId, enabled]);

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
    const ticksPerPixel = TICKS_PER_SECOND / (PIXELS_PER_SECOND * zoomScale);

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
      );
      const sourceFrame = ticksToSampleFrame(assetTick, metadata.sampleRate);
      const nextSourceFrame = ticksToSampleFrame(nextAssetTick, metadata.sampleRate);
      const framesPerPixel = Math.max(1, Math.abs(nextSourceFrame - sourceFrame));
      const level = resolveWaveformLevel(framesPerPixel, metadata);
      const peakIndex = Math.floor(sourceFrame / getFramesPerPeak(level, metadata));
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
      const maxAmplitude = int16ToAmplitude(match.bucket[bucketOffset + 1] ?? 0);
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
    markWaveformReady,
    updateCanvasGeometry,
    zoomScale,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    updateCanvasGeometry();
    draw();
  }, [draw, enabled, updateCanvasGeometry]);

  useEffect(() => {
    if (!enabled || asset?.type !== "audio" || !clip.assetId) {
      return;
    }

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

      const input = await getAssetInput(clip.assetId!);
      if (!input) {
        return null;
      }

      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) {
        return null;
      }

      const metadata: WaveformAssetMetadata = {
        sampleRate: track.sampleRate,
        numberOfChannels: track.numberOfChannels,
        durationSeconds: await track.computeDuration(),
        firstTimestampSeconds: await track.getFirstTimestamp(),
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
      const ticksPerPixel = TICKS_PER_SECOND / (PIXELS_PER_SECOND * zoomScale);

      for (let localX = 0; localX < localWidth; localX++) {
        const globalX = localStart + localX;
        const pixelOffset = globalX - leftWingPx;
        const assetTick = getAssetTickForPixel(
          clip,
          pixelOffset,
          ticksPerPixel,
          metadata.firstTimestampSeconds,
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
        );
        const sourceFrame = ticksToSampleFrame(assetTick, metadata.sampleRate);
        const nextSourceFrame = ticksToSampleFrame(nextAssetTick, metadata.sampleRate);
        const framesPerPixel = Math.max(1, Math.abs(nextSourceFrame - sourceFrame));
        const level = resolveWaveformLevel(framesPerPixel, metadata);
        const peakIndex = Math.floor(sourceFrame / getFramesPerPeak(level, metadata));
        const bucketIndex = Math.floor(peakIndex / metadata.peaksPerBucket);

        if (!waveformCacheService.hasBucket(clip.assetId!, level, bucketIndex)) {
          const bucketsAtLevel = bucketsByLevel.get(level) ?? new Set<number>();
          bucketsAtLevel.add(bucketIndex);
          bucketsByLevel.set(level, bucketsAtLevel);
        }
      }

      return bucketsByLevel;
    };

    const analyzeBucketRange = async (
      sink: AudioSampleSink,
      metadata: WaveformAssetMetadata,
      level: number,
      range: BucketRange,
    ): Promise<boolean> => {
      const framesPerPeak = getFramesPerPeak(level, metadata);
      const framesPerBucket = framesPerPeak * metadata.peaksPerBucket;
      const startFrame = range.start * framesPerBucket;
      const endFrameExclusive = (range.end + 1) * framesPerBucket;
      const mutableBuckets = new Map<number, MutableBucket>();
      const startSeconds = resolveWaveformBucketRequestSeconds(
        range.start,
        framesPerBucket,
        metadata.sampleRate,
        metadata.firstTimestampSeconds,
      );
      const endSeconds = endFrameExclusive / metadata.sampleRate;

      for (let bucketIndex = range.start; bucketIndex <= range.end; bucketIndex++) {
        mutableBuckets.set(bucketIndex, createMutableBucket());
      }

      for await (const sample of sink.samples(startSeconds, endSeconds)) {
        if (signal.aborted) {
          sample.close();
          return false;
        }

        const channelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < sample.numberOfChannels; channelIndex++) {
          const options = {
            planeIndex: channelIndex,
            format: "f32-planar" as const,
          };
          const bytesNeeded = sample.allocationSize(options);
          const channelBuffer = new Float32Array(bytesNeeded / 4);
          sample.copyTo(channelBuffer, options);
          channelData.push(channelBuffer);
        }

        const sampleStartFrame = Math.max(
          0,
          Math.round(sample.timestamp * metadata.sampleRate),
        );
        const sampleEndFrame = sampleStartFrame + sample.numberOfFrames;
        const processStartFrame = Math.max(sampleStartFrame, startFrame);
        const processEndFrame = Math.min(sampleEndFrame, endFrameExclusive);

        if (processEndFrame > processStartFrame) {
          for (
            let absoluteFrame = processStartFrame;
            absoluteFrame < processEndFrame;
            absoluteFrame++
          ) {
            const localFrame = absoluteFrame - sampleStartFrame;
            let frameMin = 1;
            let frameMax = -1;

            for (let channelIndex = 0; channelIndex < channelData.length; channelIndex++) {
              const sampleValue = channelData[channelIndex]?.[localFrame] ?? 0;
              frameMin = Math.min(frameMin, sampleValue);
              frameMax = Math.max(frameMax, sampleValue);
            }

            const bucketIndex = Math.floor(absoluteFrame / framesPerBucket);
            const bucket = mutableBuckets.get(bucketIndex);
            if (!bucket) {
              continue;
            }

            const bucketStartFrame = bucketIndex * framesPerBucket;
            const peakIndex = Math.floor(
              (absoluteFrame - bucketStartFrame) / framesPerPeak,
            );
            bucket.initialized[peakIndex] = 1;
            bucket.min[peakIndex] = Math.min(bucket.min[peakIndex] ?? 1, frameMin);
            bucket.max[peakIndex] = Math.max(bucket.max[peakIndex] ?? -1, frameMax);
          }
        }

        sample.close();
      }

      let storedAnyBucket = false;

      for (let bucketIndex = range.start; bucketIndex <= range.end; bucketIndex++) {
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

        const input = await getAssetInput(clip.assetId!);
        if (!input) {
          setWaveformStatus("unavailable");
          return;
        }

        const track = await input.getPrimaryAudioTrack();
        if (!track || !(await track.canDecode())) {
          setWaveformStatus("unavailable");
          return;
        }

        const sink = new AudioSampleSink(track);
        const sortedLevels = Array.from(missingBuckets.keys()).sort((a, b) => a - b);

        for (const level of sortedLevels) {
          if (signal.aborted) {
            return;
          }

          const bucketIndices = Array.from(missingBuckets.get(level) ?? []).sort(
            (a, b) => a - b,
          );

          for (const range of groupContiguousIndices(bucketIndices)) {
            const stored = await analyzeBucketRange(sink, metadata, level, range);
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
    scrollContainer,
    updateCanvasGeometry,
    updateViewportState,
    zoomScale,
  ]);

  return {
    showFallbackOverlay: enabled && waveformStatus !== "ready",
  };
}
