import { useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { TICKS_PER_SECOND, PIXELS_PER_SECOND, CLIP_HEIGHT } from "../constants";
import type { BaseClip, TimelineClip } from "../../../types/TimelineTypes";
import { ensureAssetSourceLoaded, useAsset } from "../../userAssets";
import {
  Input,
  UrlSource,
  BlobSource,
  VideoSampleSink,
  ALL_FORMATS,
} from "mediabunny";
import { calculateClipTime } from "../../transformations";
import { thumbnailCacheService } from "../services/ThumbnailCacheService";
import {
  clampThumbnailAssetTickToFirstFrame,
  resolveThumbnailBucketRequestSeconds,
} from "../utils/thumbnailTiming";
import { useClipCanvasWindow } from "./useClipCanvasWindow";

interface UseThumbnailRendererProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  clip: BaseClip;
  zoomScale: number;
  height: number;
  enabled?: boolean;
  isDragging?: boolean;
}

export function useThumbnailRenderer({
  canvasRef,
  clip,
  zoomScale,
  height,
  enabled = true,
  isDragging = false,
}: UseThumbnailRendererProps) {
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingDrawRef = useRef<boolean>(false);
  const throttleLastRunRef = useRef<number>(0);
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

  // Get asset immediately for synchronous draw checks
  const asset = useAsset(clip.assetId);

  // --- SHARED CACHE LIFECYCLE ---
  useEffect(() => {
    if (!clip.assetId || !enabled) return;
    thumbnailCacheService.acquire(clip.assetId);
    return () => {
      thumbnailCacheService.release(clip.assetId!);
    };
  }, [clip.assetId, enabled]);

  const clipOffset = "offset" in clip ? (clip as TimelineClip).offset : 0;
  const clipSourceDuration =
    "sourceDuration" in clip ? (clip as TimelineClip).sourceDuration : 0;

  const getCacheKey = (tier: number, index: number) => `${tier}_${index}`;

  // -------------------------------------------------------------------------
  // SYNCHRONOUS DRAW FUNCTION
  // -------------------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) return;

    if (!asset || !clip.assetId) return;

    // Get metadata synchronously
    const meta = thumbnailCacheService.getMetadata(clip.assetId);
    if (!meta) return; // Cannot draw without aspect ratio

    const { aspectRatio, firstTimestampSeconds } = meta;

    // Ensure geometry is up to date for this draw call
    const geometry = updateCanvasGeometry();
    if (!geometry) return;

    const { localStart, localWidth } = geometry;

    // Fill background
    ctx.fillStyle = "#202020";
    ctx.fillRect(0, 0, localWidth, height);

    if (asset.type === "audio") return;

    const sinkHeight = CLIP_HEIGHT;
    const sinkWidth = sinkHeight * aspectRatio;
    const slotWidth = Math.max(1, sinkWidth);

    const startIdx = Math.floor(localStart / slotWidth);
    const endIdx = Math.ceil((localStart + localWidth) / slotWidth);

    const currentPixelsPerSecond = PIXELS_PER_SECOND * zoomScale;
    const currentTicksPerPixel = TICKS_PER_SECOND / currentPixelsPerSecond;
    const zoomLog = Math.max(
      0,
      Math.floor(Math.log2(Math.max(0.1, zoomScale))),
    );
    const bucketZoom = Math.pow(2, zoomLog);
    const bucketIntervalTicks = Math.round(
      (sinkWidth / (PIXELS_PER_SECOND * bucketZoom)) * TICKS_PER_SECOND,
    );

    const isImage = asset.type === "image";
    const imgBitmap = isImage
      ? thumbnailCacheService.getThumbnail(clip.assetId!, "image_base")
      : null;

    for (let i = startIdx; i < endIdx; i++) {
      const globalX = i * slotWidth;
      const drawX = globalX - localStart;

      if (isImage && imgBitmap) {
        ctx.drawImage(
          imgBitmap,
          0,
          0,
          imgBitmap.width,
          imgBitmap.height,
          drawX,
          0,
          slotWidth,
          height,
        );
        continue;
      }

      const pixelDeltaFromClipStart = globalX - leftWingPx;
      const tickDelta = pixelDeltaFromClipStart * currentTicksPerPixel;
      const assetTick = clampThumbnailAssetTickToFirstFrame(
        calculateClipTime(clip as TimelineClip, tickDelta),
        firstTimestampSeconds,
      );

      if (
        assetTick < 0 ||
        (clip.sourceDuration && assetTick > clip.sourceDuration)
      )
        continue;

      const bucketIndex = Math.floor(assetTick / bucketIntervalTicks);
      let foundBitmap: ImageBitmap | undefined;
      let searchZoom = zoomLog;
      let searchIndex = bucketIndex;

      // Hierarchical cache lookup
      while (searchZoom >= 0) {
        const key = getCacheKey(searchZoom, searchIndex);
        const bitmap = thumbnailCacheService.getThumbnail(clip.assetId!, key);
        if (bitmap) {
          foundBitmap = bitmap;
          break;
        }
        searchZoom--;
        searchIndex = Math.floor(searchIndex / 2);
      }

      if (foundBitmap) {
        ctx.drawImage(foundBitmap, drawX, 0, slotWidth, height);
      }
    }
  }, [
    canvasRef,
    asset,
    clip,
    zoomScale,
    height,
    leftWingPx,
    updateCanvasGeometry,
  ]);

  // ---------------------------------------------------------------------------
  // LAYOUT & DRAW CYCLE
  // ---------------------------------------------------------------------------
  useLayoutEffect(() => {
    if (enabled) {
      updateCanvasGeometry();
      // IMMEDIATE DRAW: Draw in the same frame as the resize to prevent flickering
      draw();
    }
  }, [updateCanvasGeometry, enabled, draw]);

  // ---------------------------------------------------------------------------
  // ASYNC FETCHING
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!enabled || !asset) return;

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const { signal } = abortController;

    const generateThumbnails = async () => {
      updateViewportState();
      try {
        if (asset.type === "image") {
          if (
            !thumbnailCacheService.hasThumbnail(clip.assetId!, "image_base")
          ) {
            const img = new Image();
            img.src = asset.src;
            img.crossOrigin = "anonymous";
            await new Promise((r) => (img.onload = r));
            const bitmap = await createImageBitmap(img);
            thumbnailCacheService.setThumbnail(
              clip.assetId!,
              "image_base",
              bitmap,
            );
            const ar = bitmap.width / bitmap.height;
            thumbnailCacheService.setMetadata(clip.assetId!, {
              aspectRatio: ar,
            });
            requestAnimationFrame(draw);
          }
          return;
        }

        if (asset.type === "video") {
          const hydratedVideoAsset =
            asset.proxyFile ||
            asset.src.startsWith("blob:") ||
            asset.src.startsWith("http://") ||
            asset.src.startsWith("https://")
              ? asset
              : await ensureAssetSourceLoaded(asset.id);
          if (!hydratedVideoAsset) return;

          const cachedMetadata = thumbnailCacheService.getMetadata(clip.assetId!);
          let aspectRatio = cachedMetadata?.aspectRatio;
          let firstTimestampSeconds = cachedMetadata?.firstTimestampSeconds;

          if (!aspectRatio || firstTimestampSeconds === undefined) {
            const source = hydratedVideoAsset.proxyFile
              ? new BlobSource(hydratedVideoAsset.proxyFile)
              : new UrlSource(hydratedVideoAsset.src);
            using input = new Input({ source, formats: ALL_FORMATS });
            const vt = await input.getPrimaryVideoTrack();
            if (!vt) return;
            aspectRatio ??= vt.displayWidth / vt.displayHeight;
            firstTimestampSeconds ??= await vt.getFirstTimestamp();
            thumbnailCacheService.setMetadata(clip.assetId!, {
              aspectRatio,
              firstTimestampSeconds,
            });
            requestAnimationFrame(draw);
          }

          // Calculate missing chunks
          const geometry = updateCanvasGeometry();
          if (!geometry) return;
          const { localStart, localWidth } = geometry;

          const sinkHeight = CLIP_HEIGHT;
          const sinkWidth = sinkHeight * aspectRatio;
          const slotWidth = Math.max(1, sinkWidth);
          const zoomLog = Math.max(
            0,
            Math.floor(Math.log2(Math.max(0.1, zoomScale))),
          );
          const bucketZoom = Math.pow(2, zoomLog);
          const bucketIntervalTicks = Math.round(
            (sinkWidth / (PIXELS_PER_SECOND * bucketZoom)) * TICKS_PER_SECOND,
          );
          const currentTicksPerPixel =
            TICKS_PER_SECOND / (PIXELS_PER_SECOND * zoomScale);

          const startIdx = Math.floor(localStart / slotWidth);
          const endIdx = Math.ceil((localStart + localWidth) / slotWidth);
          const neededIndices = new Set<number>();

          for (let i = startIdx; i < endIdx; i++) {
            const globalX = i * slotWidth;
            const pixelDelta = globalX - leftWingPx;
            const assetTick = clampThumbnailAssetTickToFirstFrame(
              calculateClipTime(
                clip as TimelineClip,
                pixelDelta * currentTicksPerPixel,
              ),
              firstTimestampSeconds,
            );

            if (
              assetTick < 0 ||
              (clip.sourceDuration && assetTick > clip.sourceDuration)
            )
              continue;

            const bucketIndex = Math.floor(assetTick / bucketIntervalTicks);
            if (
              !thumbnailCacheService.hasThumbnail(
                clip.assetId!,
                getCacheKey(zoomLog, bucketIndex),
              )
            ) {
              neededIndices.add(bucketIndex);
            }
          }

          if (neededIndices.size === 0) return;

          const sortedIndices = Array.from(neededIndices).sort((a, b) => a - b);
          const missingTimestamps = sortedIndices.map((i) =>
            resolveThumbnailBucketRequestSeconds(
              i,
              bucketIntervalTicks,
              firstTimestampSeconds,
            ),
          );

          const source = hydratedVideoAsset.proxyFile
            ? new BlobSource(hydratedVideoAsset.proxyFile)
            : new UrlSource(hydratedVideoAsset.src);
          using input = new Input({ source, formats: ALL_FORMATS });
          const vt = await input.getPrimaryVideoTrack();
          if (!vt) return;
          const sink = new VideoSampleSink(vt);

          let requestIndex = 0;
          for await (using sample of sink.samplesAtTimestamps(
            missingTimestamps,
          )) {
            const requestedBucketIndex = sortedIndices[requestIndex];
            requestIndex++;

            if (signal.aborted) break;
            if (!sample) continue;
            const frame = sample.toVideoFrame();
            const bitmap = await createImageBitmap(frame);
            frame.close();
            if (signal.aborted) {
              bitmap.close();
              break;
            }
            thumbnailCacheService.setThumbnail(
              clip.assetId!,
              getCacheKey(
                zoomLog,
                requestedBucketIndex ??
                  Math.floor(
                    (sample.timestamp * TICKS_PER_SECOND) / bucketIntervalTicks,
                  ),
              ),
              bitmap,
            );

            if (!pendingDrawRef.current) {
              pendingDrawRef.current = true;
              requestAnimationFrame(() => {
                draw();
                pendingDrawRef.current = false;
              });
            }
          }
        }
      } catch (e) {
        if (!signal.aborted) console.warn(e);
      }
    };

    generateThumbnails();

    let debounceTimer: ReturnType<typeof setTimeout>;

    const onScroll = () => {
      if (isDragging) return;
      updateViewportState();

      // Fast Path: Draw existing cache immediately
      requestAnimationFrame(draw);

      // Throttled Fetch Path
      const now = Date.now();
      const THROTTLE_MS = 250;

      if (now - throttleLastRunRef.current > THROTTLE_MS) {
        clearTimeout(debounceTimer);
        generateThumbnails();
        throttleLastRunRef.current = now;
      } else {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          generateThumbnails();
          throttleLastRunRef.current = Date.now();
        }, 100);
      }
    };

    if (scrollContainer)
      scrollContainer.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      abortController.abort();
      if (scrollContainer)
        scrollContainer.removeEventListener("scroll", onScroll);
      clearTimeout(debounceTimer);
      pendingDrawRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fullCanvasWidth,
    leftWingPx,
    height,
    zoomScale,
    clip.assetId,
    clip.transformations,
    clipOffset,
    clipSourceDuration,
    clipStart,
    scrollContainer,
    updateCanvasGeometry,
    updateViewportState,
    enabled,
    isDragging,
    asset,
    draw,
  ]);
}
