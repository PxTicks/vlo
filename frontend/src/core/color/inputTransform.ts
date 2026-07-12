import { applyMatrix3, BT2020_TO_REC709 } from "./matrices";
import { mapHdrTransfer } from "./hdrTransfer";
import { srgbToLinear } from "./transfer";
import type { Rgb } from "./types";

export type ColorInputTransform = "srgb-rec709" | "bt2020-pq" | "bt2020-hlg";

export interface ColorInputTransformOptions {
  readonly transform: ColorInputTransform;
  /** SDR diffuse white used to normalize absolute PQ luminance. */
  readonly referenceWhiteNits?: number;
}

export function applyColorInputTransform(
  encoded: Rgb,
  options: ColorInputTransformOptions,
): Rgb {
  if (options.transform === "srgb-rec709") return srgbToLinear(encoded);
  let linear = mapHdrTransfer(
    encoded,
    options.transform === "bt2020-pq" ? "pq" : "hlg",
  );
  if (options.transform === "bt2020-pq") {
    const scale = 10_000 / Math.max(1, options.referenceWhiteNits ?? 203);
    linear = linear.map((channel) => channel * scale) as unknown as Rgb;
  }
  return applyMatrix3(BT2020_TO_REC709, linear);
}
