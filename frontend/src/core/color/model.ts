export type InputColorSpace = "auto" | "srgb" | "rec709";
export type GradingSpace = "srgb-rec709";
export type HueBasis = "hsv";

export interface ColorModelV1 {
  readonly version: 1;
  readonly input: {
    readonly defaultSpace: InputColorSpace;
    readonly decodedSpace: "srgb";
    readonly primaries: "rec709";
    readonly transfer: "srgb";
  };
  readonly working: {
    readonly linearSpace: "scene-linear-rec709";
    readonly gradingSpace: GradingSpace;
    readonly hueBasis: HueBasis;
    readonly lumaCoefficients: readonly [number, number, number];
  };
  readonly display: {
    readonly space: "srgb";
    readonly primaries: "rec709";
    readonly transfer: "srgb";
  };
  readonly export: {
    readonly primaries: "bt709";
    readonly transfer: "iec61966-2-1";
    readonly matrix: "bt709";
    readonly fullRange: false;
  };
}

/**
 * The authored model stored with a grade. It intentionally records the
 * interpretation of the controls rather than transient input-asset metadata.
 */
export interface AuthoredColorModelV1 {
  readonly version: 1;
  readonly gradingSpace: GradingSpace;
}

const LUMA_COEFFICIENTS = Object.freeze([0.2126, 0.7152, 0.0722]) as readonly [
  number,
  number,
  number,
];

/**
 * V1 decisions are frozen so later wide-gamut/HDR work adds a model version
 * instead of silently changing the meaning of existing grades.
 *
 * Hue is HSV hue in sRGB-encoded Rec.709 grading space; luma is Rec.709 Y'.
 * Browser-decoded input is treated as sRGB even when an asset is tagged 709.
 */
export const V1_COLOR_MODEL: ColorModelV1 = Object.freeze({
  version: 1,
  input: Object.freeze({
    defaultSpace: "auto",
    decodedSpace: "srgb",
    primaries: "rec709",
    transfer: "srgb",
  }),
  working: Object.freeze({
    linearSpace: "scene-linear-rec709",
    gradingSpace: "srgb-rec709",
    hueBasis: "hsv",
    lumaCoefficients: LUMA_COEFFICIENTS,
  }),
  display: Object.freeze({
    space: "srgb",
    primaries: "rec709",
    transfer: "srgb",
  }),
  export: Object.freeze({
    primaries: "bt709",
    transfer: "iec61966-2-1",
    matrix: "bt709",
    fullRange: false,
  }),
});

export const V1_AUTHORED_COLOR_MODEL: AuthoredColorModelV1 = Object.freeze({
  version: 1,
  gradingSpace: V1_COLOR_MODEL.working.gradingSpace,
});

