import {
  useEffect,
  useRef,
  useCallback,
  useState,
  useLayoutEffect,
} from "react";
import { TICKS_PER_SECOND, PIXELS_PER_SECOND, CLIP_HEIGHT } from "../constants";
import type { BaseClip, TimelineClip } from "../../../types/TimelineTypes";
import { useAsset } from "../../userAssets";
import { useTimelineViewStore } from "./useTimelineViewStore";
import { useInteractionStore } from "../hooks/useInteractionStore";
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

interface UseThumbnailRendererProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  clip: BaseClip;
  zoomScale: number;
  height: number;
  enabled?: boolean;
  isDragging?: boolean;
}

const INITIAL_WING_SIZE = 1000;
const WING_GROWTH_CHUNK = 2000;
const EXPANSION_THRESHOLD = 300;

export function useThumbnailRenderer({
  canvasRef,
  clip,
  zoomScale,
  height,
  enabled = true,
  isDragging = false,
}: UseThumbnailRendererProps) {
  const [dynamicWings, setDynamicWings] = useState({
    left: INITIAL_WING_SIZE,
    right: INITIAL_WING_SIZE,
  });

  const clipStart = "start" in clip ? (clip as TimelineClip).start : null;
  const abortControllerRef = useRef<AbortController | null>(null);
  const layoutRef = useRef({ canvasLeft: -1, canvasWidth: -1 });
  const pendingDrawRef = useRef<boolean>(false);
  const throttleLastRunRef = useRef<number>(0);

  const scrollContainer = useTimelineViewStore(
    (state) => state.scrollContainer,
  );
  const viewportRef = useRef({ scrollLeft: 0, containerWidth: 0 });

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

  const updateViewportState = useCallback(() => {
    if (scrollContainer) {
      viewportRef.current = {
        scrollLeft: scrollContainer.scrollLeft,
        containerWidth: scrollContainer.clientWidth,
      };
    }
  }, [scrollContainer]);

  const clipOffset = "offset" in clip ? (clip as TimelineClip).offset : 0;
  const clipSourceDuration =
    "sourceDuration" in clip ? (clip as TimelineClip).sourceDuration : 0;

  // --- DYNAMIC DRAG SUBSCRIPTION ---
  useEffect(() => {
    if (!enabled) return;
    setDynamicWings({ left: INITIAL_WING_SIZE, right: INITIAL_WING_SIZE });

    const unsubscribe = useInteractionStore.subscribe((state) => {
      const isLeft = state.activeId === `resize_left_${clip.id}`;
      const isRight = state.activeId === `resize_right_${clip.id}`;

      if (!isLeft && !isRight) return;

      const delta = state.currentDeltaX;
      const dragDistance = Math.abs(delta);

      setDynamicWings((prev) => {
        if (isLeft) {
          if (dragDistance > prev.left - EXPANSION_THRESHOLD) {
            return { ...prev, left: prev.left + WING_GROWTH_CHUNK };
          }
        }
        if (isRight) {
          if (dragDistance > prev.right - EXPANSION_THRESHOLD) {
            return { ...prev, right: prev.right + WING_GROWTH_CHUNK };
          }
        }
        return prev;
      });
    });

    return () => unsubscribe();
  }, [clip.id, enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    updateViewportState();
  }, [updateViewportState, enabled, isDragging]);

  // Reset wings when assetId changes
  useEffect(() => {
    layoutRef.current = { canvasLeft: -1, canvasWidth: -1 };
    setDynamicWings({ left: INITIAL_WING_SIZE, right: INITIAL_WING_SIZE });
  }, [clip.assetId]);

  // ---------------------------------------------------------------------------
  // GEOMETRY CALCULATION
  // ---------------------------------------------------------------------------
  const visibleDurationPx =
    (clip.timelineDuration / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
  const maxLeftPx =
    (clip.transformedOffset / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
  const leftWingPx = Math.min(maxLeftPx, dynamicWings.left);
  const hasUnboundedRightSide =
    clip.type === "image" || clip.sourceDuration === null;
  const remainingRightTicks = hasUnboundedRightSide
    ? 0
    : clip.transformedDuration - clip.transformedOffset - clip.timelineDuration;
  const maxRightPx = hasUnboundedRightSide
    ? Number.POSITIVE_INFINITY
    : (remainingRightTicks / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
  const rightWingPx = hasUnboundedRightSide
    ? dynamicWings.right
    : Math.min(Math.max(0, maxRightPx), dynamicWings.right);
  const fullCanvasWidth = leftWingPx + visibleDurationPx + rightWingPx;

  const updateCanvasGeometry = useCallback(() => {
    if (!scrollContainer || !canvasRef.current) return null;

    let intLocalStart = 0;
    let intWidth = 0;

    if (isDragging || clipStart === null) {
      intLocalStart = 0;
      intWidth = Math.min(16384, Math.ceil(fullCanvasWidth));
    } else {
      const { scrollLeft, containerWidth } = viewportRef.current;
      const clipGlobalStart =
        (clipStart / TICKS_PER_SECOND) * PIXELS_PER_SECOND * zoomScale;
      const virtualGlobalStart = clipGlobalStart - leftWingPx;

      const BUFFER = 1000;
      const viewStart = scrollLeft - BUFFER;
      const viewEnd = scrollLeft + containerWidth + BUFFER;

      const localStart = Math.max(0, viewStart - virtualGlobalStart);
      const localEnd = Math.min(fullCanvasWidth, viewEnd - virtualGlobalStart);

      if (localEnd <= localStart) return null;

      intWidth = Math.ceil(localEnd - localStart);
      intLocalStart = Math.floor(localStart);
    }
    const baseLeft = -leftWingPx + intLocalStart;

    const canvas = canvasRef.current;

    // Resize buffer if needed (this clears the canvas)
    if (canvas.width !== intWidth || canvas.height !== height) {
      canvas.width = intWidth;
      canvas.height = height;
    }

    const transform = `translateX(calc(${baseLeft}px - var(--drag-delta-x, 0px)))`;

    if (
      layoutRef.current.canvasLeft !== intLocalStart ||
      canvas.style.transform !== transform
    ) {
      canvas.style.transform = transform;
      layoutRef.current.canvasLeft = intLocalStart;
    }

    return { localStart: intLocalStart, localWidth: intWidth };
  }, [
    scrollContainer,
    clipStart,
    canvasRef,
    zoomScale,
    fullCanvasWidth,
    leftWingPx,
    height,
    isDragging,
  ]);

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
          const cachedMetadata = thumbnailCacheService.getMetadata(clip.assetId!);
          let aspectRatio = cachedMetadata?.aspectRatio;
          let firstTimestampSeconds = cachedMetadata?.firstTimestampSeconds;

          if (!aspectRatio || firstTimestampSeconds === undefined) {
            const source = asset.proxyFile
              ? new BlobSource(asset.proxyFile)
              : new UrlSource(asset.src);
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

          const source = asset.proxyFile
            ? new BlobSource(asset.proxyFile)
            : new UrlSource(asset.src);
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
