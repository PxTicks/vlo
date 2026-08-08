import type {
  ExtensionModule,
  ExtensionScopeRenderContext,
} from "@vlo/extension-sdk";

/**
 * Exposure bands, darkest first. The package exports the classifier over these
 * so a companion package can describe a frame in the same words the scope
 * paints it in — which is the point of an exported API: one vocabulary, two
 * packages, no shared global.
 */
export interface ExposureZone {
  readonly name: string;
  /** Inclusive lower bound on luma, 0 to 1. */
  readonly min: number;
  readonly color: readonly [number, number, number];
}

export const EXPOSURE_ZONES: readonly ExposureZone[] = [
  { name: "crushed", min: 0, color: [40, 40, 120] },
  { name: "shadow", min: 0.05, color: [40, 140, 200] },
  { name: "midtone", min: 0.25, color: [90, 90, 90] },
  { name: "highlight", min: 0.7, color: [220, 190, 60] },
  { name: "clipped", min: 0.95, color: [235, 60, 60] },
];

export function classifyLuma(luma: number): ExposureZone {
  let zone = EXPOSURE_ZONES[0];
  for (const candidate of EXPOSURE_ZONES) {
    if (luma >= candidate.min) zone = candidate;
  }
  return zone;
}

/** The shape this package publishes through `context.exportApi()`. */
export interface FalseColorApi {
  readonly apiVersion: 1;
  readonly zones: readonly ExposureZone[];
  classifyLuma(luma: number): ExposureZone;
}

export const falseColorApi: FalseColorApi = {
  apiVersion: 1,
  zones: EXPOSURE_ZONES,
  classifyLuma,
};

const SCOPE_WIDTH = 256;
const SCOPE_HEIGHT = 144;

/**
 * Paints the sampled frame as exposure bands. The pixels belong to the host and
 * are only valid inside this call, so nothing is retained — the image data
 * written back is allocated per draw from the host's own 2D context.
 */
export function renderFalseColor(context: ExtensionScopeRenderContext): void {
  const { frame, width, height } = context;
  const image = context.context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      frame.height - 1,
      Math.floor((y / height) * frame.height),
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        frame.width - 1,
        Math.floor((x / width) * frame.width),
      );
      const source = (sourceY * frame.width + sourceX) * 4;
      const alpha = frame.pixels[source + 3] / 255;
      const target = (y * width + x) * 4;
      if (alpha <= 1e-6) {
        image.data[target + 3] = 255;
        continue;
      }
      // The host samples premultiplied RGBA, so undo alpha before measuring.
      const r = Math.min(1, frame.pixels[source] / 255 / alpha);
      const g = Math.min(1, frame.pixels[source + 1] / 255 / alpha);
      const b = Math.min(1, frame.pixels[source + 2] / 255 / alpha);
      const zone = classifyLuma(r * 0.2126 + g * 0.7152 + b * 0.0722);
      image.data[target] = zone.color[0];
      image.data[target + 1] = zone.color[1];
      image.data[target + 2] = zone.color[2];
      image.data[target + 3] = 255;
    }
  }
  context.context.putImageData(image, 0, 0);
}

export const activate: ExtensionModule["activate"] = (context) => {
  context.api.ui.scopes.register({
    id: "false-color",
    apiVersion: 1,
    kind: "trusted-scope",
    label: "False Colour",
    width: SCOPE_WIDTH,
    height: SCOPE_HEIGHT,
    order: 100,
    render: renderFalseColor,
  });

  // Published only once activation succeeds, and retracted on deactivation, so
  // a dependent never holds an API from a session the host rolled back.
  context.exportApi(falseColorApi);

  context.logger.info("false colour scope registered");
};
