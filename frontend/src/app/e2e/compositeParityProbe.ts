import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
} from "mediabunny";
import { playbackClock } from "../../core/playback/PlaybackClock";
import { useCompositeLibraryStore } from "../../features/composite/useCompositeLibraryStore";
import {
  isCompositeForceLive,
  setCompositeForceLive,
} from "../../features/composite/useCompositeRenderStatusStore";
import { renderCompositeToVideoFile } from "../../features/composite/services/bakeComposite";
import {
  COMPOSITE_DECODED_PIXEL_TOLERANCE,
  COMPOSITE_PREENCODE_PIXEL_TOLERANCE,
  captureCompositeCanvasPixels,
  compareCompositePixelFrames,
  type CompositePixelComparison,
  type CompositePixelFrame,
} from "../../features/composite/utils/compositeParityHarness";
import { compositeContentToSelection } from "../../features/timelineSelection";
import { getTicksPerFrame } from "../../features/timelineSelection";

interface LiveCompositeFrame extends CompositePixelFrame {
  compositeId: string;
  localPresentationTick: number;
}

interface PendingLiveCapture {
  compositeId: string;
  resolve: (frame: LiveCompositeFrame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  receivedFrames: number;
  lastFrameDimensions: { width: number; height: number } | null;
  receivedDimensionKeys: Set<string>;
}

let pendingLiveCapture: PendingLiveCapture | null = null;
let probeInFlight = false;

/**
 * The canonical parity probe compares the production source-fidelity live and
 * bake paths. Normal interactive frames continue to use preview output demand.
 */
export function requiresSourceFidelityCompositeFrame(): boolean {
  return pendingLiveCapture !== null;
}

export interface CompositeParityProbeRequest {
  compositeId: string;
  /** Main-timeline tick at which the requested composite placement is active. */
  placementTick: number;
}

export interface CompositeParityProbeResult {
  liveVsPreEncode: CompositePixelComparison;
  preEncodeVsDecoded: CompositePixelComparison;
  diagnostics: {
    live: FrameDiagnostics;
    preEncode: FrameDiagnostics;
    decoded: FrameDiagnostics;
  };
  width: number;
  height: number;
  localPresentationTick: number;
  encodedBytes: number;
  encodedType: string;
}

interface FrameDiagnostics {
  meanRgba: [number, number, number, number];
  nonTransparentPixelRatio: number;
  centerRgba: [number, number, number, number];
}

function diagnoseFrame(frame: CompositePixelFrame): FrameDiagnostics {
  const totals = [0, 0, 0, 0];
  let nonTransparentPixels = 0;
  for (let offset = 0; offset < frame.pixels.length; offset += 4) {
    for (let channel = 0; channel < 4; channel += 1) {
      totals[channel] += frame.pixels[offset + channel];
    }
    if (frame.pixels[offset + 3] > 0) nonTransparentPixels += 1;
  }
  const pixelCount = frame.width * frame.height;
  const centerOffset =
    (Math.floor(frame.height / 2) * frame.width + Math.floor(frame.width / 2)) *
    4;
  return {
    meanRgba: totals.map((total) => total / pixelCount) as [
      number,
      number,
      number,
      number,
    ],
    nonTransparentPixelRatio: nonTransparentPixels / pixelCount,
    centerRgba: Array.from(
      frame.pixels.slice(centerOffset, centerOffset + 4),
    ) as [number, number, number, number],
  };
}

function validateRequest(request: CompositeParityProbeRequest): void {
  if (!request.compositeId.trim()) {
    throw new Error("composite parity probe: compositeId is required");
  }
  for (const [name, value] of Object.entries({
    placementTick: request.placementTick,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `composite parity probe: ${name} must be a non-negative integer tick`,
      );
    }
  }
}

function waitForLiveFrame(compositeId: string): Promise<LiveCompositeFrame> {
  if (pendingLiveCapture) {
    throw new Error("composite parity probe: a live capture is already pending");
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending =
        pendingLiveCapture?.resolve === resolve ? pendingLiveCapture : null;
      if (pending) {
        pendingLiveCapture = null;
      }
      reject(
        new Error(
          `composite parity probe: timed out waiting for ${compositeId} ` +
            `(received ${pending?.receivedFrames ?? 0} frames; ` +
            `last dimensions ${pending?.lastFrameDimensions?.width ?? "n/a"}x` +
            `${pending?.lastFrameDimensions?.height ?? "n/a"}; ` +
            `observed ${[...(pending?.receivedDimensionKeys ?? [])].join(", ") || "none"})`,
        ),
      );
    }, 60_000);
    pendingLiveCapture = {
      compositeId,
      resolve,
      reject,
      timeout,
      receivedFrames: 0,
      lastFrameDimensions: null,
      receivedDimensionKeys: new Set(),
    };
  });
}

/**
 * Synchronous receiver called while the live composite texture lease is still
 * valid. Installed only in explicitly diagnostic builds.
 */
export function acceptLiveCompositeFrame(frame: LiveCompositeFrame): void {
  const pending = pendingLiveCapture;
  if (!pending || pending.compositeId !== frame.compositeId) {
    return;
  }
  pending.receivedFrames += 1;
  pending.lastFrameDimensions = {
    width: frame.width,
    height: frame.height,
  };
  pending.receivedDimensionKeys.add(`${frame.width}x${frame.height}`);
  // A cold decoder can legitimately produce a transparent deferred frame
  // before its first source frame is resident. That is not a rendered parity
  // sample; keep the request pending until the live path has real pixels.
  let hasVisiblePixel = false;
  for (let offset = 3; offset < frame.pixels.length; offset += 4) {
    if (frame.pixels[offset] > 0) {
      hasVisiblePixel = true;
      break;
    }
  }
  if (!hasVisiblePixel) return;
  clearTimeout(pending.timeout);
  pendingLiveCapture = null;
  pending.resolve({
    ...frame,
    pixels: new Uint8ClampedArray(frame.pixels),
  });
}

export function rejectLiveCompositeFrame(error: string): void {
  cancelPendingCapture(
    `composite parity probe: live extraction failed: ${error}`,
  );
}

function cancelPendingCapture(reason: string): void {
  if (!pendingLiveCapture) return;
  const pending = pendingLiveCapture;
  pendingLiveCapture = null;
  clearTimeout(pending.timeout);
  pending.reject(new Error(reason));
}

export async function runCompositeParityProbe(
  request: CompositeParityProbeRequest,
): Promise<CompositeParityProbeResult> {
  validateRequest(request);
  if (probeInFlight) {
    throw new Error("composite parity probe: a probe is already running");
  }
  probeInFlight = true;

  const composite = useCompositeLibraryStore
    .getState()
    .composites.find((candidate) => candidate.id === request.compositeId);
  if (!composite) {
    probeInFlight = false;
    throw new Error(
      `composite parity probe: unknown composite '${request.compositeId}'`,
    );
  }

  const wasForceLive = isCompositeForceLive(request.compositeId);
  try {
    const livePromise = waitForLiveFrame(request.compositeId);
    setCompositeForceLive(request.compositeId, true);
    // Force-live is a subscribed React input to Player's source-policy
    // snapshot. Let that render commit before requesting the target clock
    // frame; requesting synchronously races the previous baked policy.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    // Ensure a clock notification even if the requested tick was already
    // current, then request the exact target frame.
    const requestTargetFrame = () => {
      playbackClock.setTime(Math.max(0, request.placementTick - 1));
      playbackClock.setTime(request.placementTick);
    };
    requestTargetFrame();
    // Strict preview may first defer while its decoder warms. A paused player
    // has no playback loop to request another epoch, so pulse the same target
    // until the synchronous receiver observes a non-transparent live frame.
    const retry = setInterval(requestTargetFrame, 250);
    let live: LiveCompositeFrame;
    try {
      live = await livePromise;
    } finally {
      clearInterval(retry);
    }

    const fps =
      typeof composite.content.fps === "number" &&
      Number.isFinite(composite.content.fps)
        ? Math.max(1, composite.content.fps)
        : 1;
    const ticksPerFrame = getTicksPerFrame(fps);
    const fullSelection = compositeContentToSelection(composite.content);
    const selection = {
      ...fullSelection,
      start: live.localPresentationTick,
      end: Math.min(
        composite.content.durationTicks,
        live.localPresentationTick + ticksPerFrame,
      ),
    };
    if (selection.end <= selection.start) {
      throw new Error(
        "composite parity probe: requested local frame is outside the composite",
      );
    }

    const preEncodeFrames: CompositePixelFrame[] = [];
    const rendered = await renderCompositeToVideoFile(composite.content, {
      selection,
      onBeforeEncodeFrame: (frame) => {
        if (preEncodeFrames.length === 0) {
          preEncodeFrames.push({
            width: frame.width,
            height: frame.height,
            pixels: new Uint8ClampedArray(frame.pixels),
          });
        }
      },
    });
    const preEncode = preEncodeFrames[0];
    if (!preEncode) {
      throw new Error("composite parity probe: export produced no frame");
    }

    const input = new Input({
      source: new BlobSource(rendered),
      formats: ALL_FORMATS,
    });
    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw new Error("composite parity probe: bake has no video track");
      }
      const wrapped = await new CanvasSink(videoTrack, {
        alpha: true,
        poolSize: 1,
      }).getCanvas(0);
      if (!wrapped || !(wrapped.canvas instanceof HTMLCanvasElement)) {
        throw new Error("composite parity probe: decoded frame is unavailable");
      }
      const decoded = captureCompositeCanvasPixels(wrapped.canvas);
      const liveVsPreEncode = compareCompositePixelFrames(
        live,
        preEncode,
        COMPOSITE_PREENCODE_PIXEL_TOLERANCE,
      );
      const preEncodeVsDecoded = compareCompositePixelFrames(
        preEncode,
        decoded,
        COMPOSITE_DECODED_PIXEL_TOLERANCE,
      );
      return {
        liveVsPreEncode,
        preEncodeVsDecoded,
        diagnostics: {
          live: diagnoseFrame(live),
          preEncode: diagnoseFrame(preEncode),
          decoded: diagnoseFrame(decoded),
        },
        width: preEncode.width,
        height: preEncode.height,
        localPresentationTick: live.localPresentationTick,
        encodedBytes: rendered.size,
        encodedType: rendered.type,
      };
    } finally {
      input.dispose();
    }
  } finally {
    cancelPendingCapture("composite parity probe: capture cancelled");
    setCompositeForceLive(request.compositeId, wasForceLive);
    probeInFlight = false;
  }
}
