export type CompositeParityStage =
  | "live"
  | "pre-encode"
  | "decoded-bake";

export interface CompositePixelFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export type CompositePixelCapture = () =>
  | CompositePixelFrame
  | Promise<CompositePixelFrame>;

export interface CompositeParityCaptureSources {
  live: CompositePixelCapture;
  preEncode: CompositePixelCapture;
  decodedBake: CompositePixelCapture;
}

export interface CompositeParityCaptureSet {
  live: CompositePixelFrame;
  preEncode: CompositePixelFrame;
  decodedBake: CompositePixelFrame;
}

export interface CompositePixelTolerance {
  maxChannelDelta: number;
  maxMeanAbsoluteChannelDelta: number;
  maxDifferentPixelRatio: number;
  differentPixelChannelThreshold: number;
}

export interface CompositePixelComparison {
  passed: boolean;
  dimensionsMatch: boolean;
  maxChannelDelta: number;
  meanAbsoluteChannelDelta: number;
  differentPixelRatio: number;
  differentPixelCount: number;
  pixelCount: number;
}

export interface CompositeCoordinateProbe {
  id: "top-left" | "top-right" | "center" | "bottom-left" | "bottom-right";
  x: number;
  y: number;
  rgba: readonly [number, number, number, number];
}

export interface CompositeCoordinateProbeFrame {
  frame: CompositePixelFrame;
  probes: readonly CompositeCoordinateProbe[];
}

/** Same-backend live vs pre-encode comparison. */
export const COMPOSITE_PREENCODE_PIXEL_TOLERANCE: CompositePixelTolerance = {
  maxChannelDelta: 1,
  maxMeanAbsoluteChannelDelta: 0.05,
  maxDifferentPixelRatio: 0.001,
  differentPixelChannelThreshold: 1,
};

/**
 * Baseline for lossy decoded-cache smoke tests. Codec-specific suites may use
 * tighter limits, but must never silently relax these repository defaults.
 */
export const COMPOSITE_DECODED_PIXEL_TOLERANCE: CompositePixelTolerance = {
  maxChannelDelta: 32,
  maxMeanAbsoluteChannelDelta: 6,
  maxDifferentPixelRatio: 0.35,
  differentPixelChannelThreshold: 8,
};

function copyAndValidateFrame(frame: CompositePixelFrame): CompositePixelFrame {
  const width = Math.round(frame.width);
  const height = Math.round(frame.height);
  if (width <= 0 || height <= 0) {
    throw new Error("Composite parity frames require positive dimensions");
  }
  const expectedLength = width * height * 4;
  if (frame.pixels.length !== expectedLength) {
    throw new Error(
      `Composite parity frame expected ${expectedLength} RGBA bytes, received ${frame.pixels.length}`,
    );
  }
  return {
    width,
    height,
    pixels: new Uint8ClampedArray(frame.pixels),
  };
}

/**
 * Captures all three equivalence stages through narrow adapters. The live
 * source is captured from the composite executor's pre-parent-operation
 * texture seam; export supplies the pre-encode frame, and a headed decoder
 * fixture supplies the decoded bake.
 */
export async function captureCompositeParityFrames(
  sources: CompositeParityCaptureSources,
): Promise<CompositeParityCaptureSet> {
  const [live, preEncode, decodedBake] = await Promise.all([
    sources.live(),
    sources.preEncode(),
    sources.decodedBake(),
  ]);
  return {
    live: copyAndValidateFrame(live),
    preEncode: copyAndValidateFrame(preEncode),
    decodedBake: copyAndValidateFrame(decodedBake),
  };
}

/** Adapts Pixi's renderer.extract.pixels result without owning Pixi objects. */
export function captureExtractedCompositePixels(extract: () => {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}): CompositePixelFrame {
  const result = extract();
  return copyAndValidateFrame({
    width: result.width,
    height: result.height,
    pixels: new Uint8ClampedArray(result.pixels),
  });
}

/** Captures a specific live RenderTexture through a Pixi-compatible extractor. */
export function captureCompositeTexturePixels<TTexture>(
  texture: TTexture,
  extract: (texture: TTexture) => {
    width: number;
    height: number;
    pixels: Uint8Array | Uint8ClampedArray;
  },
): CompositePixelFrame {
  return captureExtractedCompositePixels(() => extract(texture));
}

/** Adapts a headed decoded-video canvas to the parity frame contract. */
export function captureCompositeCanvasPixels(
  canvas: HTMLCanvasElement,
): CompositePixelFrame {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Composite parity capture requires a 2D canvas context");
  }
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return copyAndValidateFrame({
    width: image.width,
    height: image.height,
    pixels: image.data,
  });
}

export function compareCompositePixelFrames(
  reference: CompositePixelFrame,
  candidate: CompositePixelFrame,
  tolerance: CompositePixelTolerance,
): CompositePixelComparison {
  if (
    reference.width !== candidate.width ||
    reference.height !== candidate.height
  ) {
    return {
      passed: false,
      dimensionsMatch: false,
      maxChannelDelta: 255,
      meanAbsoluteChannelDelta: 255,
      differentPixelRatio: 1,
      differentPixelCount: Math.max(
        reference.width * reference.height,
        candidate.width * candidate.height,
      ),
      pixelCount: reference.width * reference.height,
    };
  }

  const referenceFrame = copyAndValidateFrame(reference);
  const candidateFrame = copyAndValidateFrame(candidate);
  let maxChannelDelta = 0;
  let totalChannelDelta = 0;
  let differentPixelCount = 0;

  for (let offset = 0; offset < referenceFrame.pixels.length; offset += 4) {
    let isDifferentPixel = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        referenceFrame.pixels[offset + channel] -
          candidateFrame.pixels[offset + channel],
      );
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      totalChannelDelta += delta;
      if (delta > tolerance.differentPixelChannelThreshold) {
        isDifferentPixel = true;
      }
    }
    if (isDifferentPixel) {
      differentPixelCount += 1;
    }
  }

  const pixelCount = reference.width * reference.height;
  const meanAbsoluteChannelDelta =
    totalChannelDelta / referenceFrame.pixels.length;
  const differentPixelRatio = differentPixelCount / pixelCount;
  return {
    passed:
      maxChannelDelta <= tolerance.maxChannelDelta &&
      meanAbsoluteChannelDelta <= tolerance.maxMeanAbsoluteChannelDelta &&
      differentPixelRatio <= tolerance.maxDifferentPixelRatio,
    dimensionsMatch: true,
    maxChannelDelta,
    meanAbsoluteChannelDelta,
    differentPixelRatio,
    differentPixelCount,
    pixelCount,
  };
}

function setPixel(
  pixels: Uint8ClampedArray,
  width: number,
  probe: CompositeCoordinateProbe,
): void {
  const offset = (probe.y * width + probe.x) * 4;
  pixels.set(probe.rgba, offset);
}

/**
 * Creates transparent edges plus unique corner/centre markers. A shifted,
 * flipped, cropped, incorrectly anchored, or opaque composite fails against
 * this fixture without requiring source media.
 */
export function createCompositeCoordinateProbeFrame(
  width: number,
  height: number,
  margin = 1,
): CompositeCoordinateProbeFrame {
  const safeWidth = Math.round(width);
  const safeHeight = Math.round(height);
  const safeMargin = Math.round(margin);
  if (
    safeWidth < 3 ||
    safeHeight < 3 ||
    safeMargin < 1 ||
    safeMargin * 2 >= safeWidth ||
    safeMargin * 2 >= safeHeight
  ) {
    throw new Error("Composite coordinate probes require an inset drawable area");
  }

  const probes: CompositeCoordinateProbe[] = [
    { id: "top-left", x: safeMargin, y: safeMargin, rgba: [255, 0, 0, 255] },
    {
      id: "top-right",
      x: safeWidth - 1 - safeMargin,
      y: safeMargin,
      rgba: [0, 255, 0, 255],
    },
    {
      id: "center",
      x: Math.floor(safeWidth / 2),
      y: Math.floor(safeHeight / 2),
      rgba: [255, 0, 255, 255],
    },
    {
      id: "bottom-left",
      x: safeMargin,
      y: safeHeight - 1 - safeMargin,
      rgba: [0, 0, 255, 255],
    },
    {
      id: "bottom-right",
      x: safeWidth - 1 - safeMargin,
      y: safeHeight - 1 - safeMargin,
      rgba: [255, 255, 0, 255],
    },
  ];
  const pixels = new Uint8ClampedArray(safeWidth * safeHeight * 4);
  probes.forEach((probe) => setPixel(pixels, safeWidth, probe));
  return {
    frame: { width: safeWidth, height: safeHeight, pixels },
    probes,
  };
}
