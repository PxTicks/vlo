import {
  DEFAULT_COLOR_CURVES,
  DEFAULT_COLOR_GRADE_LUT,
  DEFAULT_COLOR_GRADE_PRIMARIES,
  DEFAULT_COLOR_QUALIFIER,
  MODIFIER_CURVE_PARAMETER_NAMES,
  VALUE_CURVE_PARAMETER_NAMES,
  isIdentityColorCurve,
  type ColorCurveParameterName,
  type ColorCurvePoint,
  type ColorGradeLutParameters,
  type ColorGradeReferenceParameters,
  type ColorQualifierParameters,
} from "../../../../../core/color";
import type { ResolvedColorGradeLayer } from "../../filterPreResolution";
import { COLOR_GRADE_SHADER_STAGE } from "./shader";
import { FUSED_COLOR_GRADE_SHADER_STAGE } from "./fusedShaderStages";

export interface NormalizedColorGradeLayer {
  readonly transformId: string;
  readonly parameters: ColorGradeReferenceParameters &
    ColorQualifierParameters &
    ColorGradeLutParameters;
  readonly ditherStrength: number;
  readonly variantKey: number;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function curvePoints(
  name: ColorCurveParameterName,
  value: unknown,
): readonly ColorCurvePoint[] {
  if (!Array.isArray(value)) return DEFAULT_COLOR_CURVES[name];
  const points = value
    .filter(
      (point): point is ColorCurvePoint =>
        typeof point === "object" &&
        point !== null &&
        "x" in point &&
        "y" in point &&
        typeof point.x === "number" &&
        Number.isFinite(point.x) &&
        typeof point.y === "number" &&
        Number.isFinite(point.y),
    )
    .map((point) => ({
      x: Math.max(0, Math.min(1, point.x)),
      y: point.y,
    }))
    .sort((left, right) => left.x - right.x);
  return points.length > 0 ? points : DEFAULT_COLOR_CURVES[name];
}

export function normalizeColorGradeLayer(
  layer: ResolvedColorGradeLayer,
): NormalizedColorGradeLayer {
  const source = layer.parameters;
  const satA = clamp(finiteOr(source.satLo, DEFAULT_COLOR_QUALIFIER.satLo), 0, 1);
  const satB = clamp(finiteOr(source.satHi, DEFAULT_COLOR_QUALIFIER.satHi), 0, 1);
  const lumaA = clamp(finiteOr(source.lumaLo, DEFAULT_COLOR_QUALIFIER.lumaLo), 0, 1);
  const lumaB = clamp(finiteOr(source.lumaHi, DEFAULT_COLOR_QUALIFIER.lumaHi), 0, 1);
  const parameters: ColorGradeReferenceParameters &
    ColorQualifierParameters &
    ColorGradeLutParameters = {
    exposure: finiteOr(source.exposure, DEFAULT_COLOR_GRADE_PRIMARIES.exposure),
    temperature: finiteOr(
      source.temperature,
      DEFAULT_COLOR_GRADE_PRIMARIES.temperature,
    ),
    tint: finiteOr(source.tint, DEFAULT_COLOR_GRADE_PRIMARIES.tint),
    contrast: Math.max(
      0,
      finiteOr(source.contrast, DEFAULT_COLOR_GRADE_PRIMARIES.contrast),
    ),
    pivot: finiteOr(source.pivot, DEFAULT_COLOR_GRADE_PRIMARIES.pivot),
    kneeThreshold: finiteOr(
      source.kneeThreshold,
      DEFAULT_COLOR_GRADE_PRIMARIES.kneeThreshold,
    ),
    kneeSoftness: Math.max(
      0,
      finiteOr(
        source.kneeSoftness,
        DEFAULT_COLOR_GRADE_PRIMARIES.kneeSoftness,
      ),
    ),
    toeAmount: Math.max(
      0,
      Math.min(
        1,
        finiteOr(source.toeAmount, DEFAULT_COLOR_GRADE_PRIMARIES.toeAmount),
      ),
    ),
    toeSoftness: Math.max(
      0,
      finiteOr(source.toeSoftness, DEFAULT_COLOR_GRADE_PRIMARIES.toeSoftness),
    ),
    saturation: Math.max(
      0,
      finiteOr(source.saturation, DEFAULT_COLOR_GRADE_PRIMARIES.saturation),
    ),
    vibrance: Math.max(
      -1,
      Math.min(
        1,
        finiteOr(source.vibrance, DEFAULT_COLOR_GRADE_PRIMARIES.vibrance),
      ),
    ),
    hueRotate: finiteOr(
      source.hueRotate,
      DEFAULT_COLOR_GRADE_PRIMARIES.hueRotate,
    ),
    liftR: finiteOr(source.liftR, DEFAULT_COLOR_GRADE_PRIMARIES.liftR),
    liftG: finiteOr(source.liftG, DEFAULT_COLOR_GRADE_PRIMARIES.liftG),
    liftB: finiteOr(source.liftB, DEFAULT_COLOR_GRADE_PRIMARIES.liftB),
    liftMaster: finiteOr(
      source.liftMaster,
      DEFAULT_COLOR_GRADE_PRIMARIES.liftMaster,
    ),
    gammaR: finiteOr(source.gammaR, DEFAULT_COLOR_GRADE_PRIMARIES.gammaR),
    gammaG: finiteOr(source.gammaG, DEFAULT_COLOR_GRADE_PRIMARIES.gammaG),
    gammaB: finiteOr(source.gammaB, DEFAULT_COLOR_GRADE_PRIMARIES.gammaB),
    gammaMaster: finiteOr(
      source.gammaMaster,
      DEFAULT_COLOR_GRADE_PRIMARIES.gammaMaster,
    ),
    gainR: finiteOr(source.gainR, DEFAULT_COLOR_GRADE_PRIMARIES.gainR),
    gainG: finiteOr(source.gainG, DEFAULT_COLOR_GRADE_PRIMARIES.gainG),
    gainB: finiteOr(source.gainB, DEFAULT_COLOR_GRADE_PRIMARIES.gainB),
    gainMaster: finiteOr(
      source.gainMaster,
      DEFAULT_COLOR_GRADE_PRIMARIES.gainMaster,
    ),
    offsetR: finiteOr(source.offsetR, DEFAULT_COLOR_GRADE_PRIMARIES.offsetR),
    offsetG: finiteOr(source.offsetG, DEFAULT_COLOR_GRADE_PRIMARIES.offsetG),
    offsetB: finiteOr(source.offsetB, DEFAULT_COLOR_GRADE_PRIMARIES.offsetB),
    offsetMaster: finiteOr(
      source.offsetMaster,
      DEFAULT_COLOR_GRADE_PRIMARIES.offsetMaster,
    ),
    curveMaster: curvePoints("curveMaster", source.curveMaster),
    curveR: curvePoints("curveR", source.curveR),
    curveG: curvePoints("curveG", source.curveG),
    curveB: curvePoints("curveB", source.curveB),
    curveHueHue: curvePoints("curveHueHue", source.curveHueHue),
    curveHueSat: curvePoints("curveHueSat", source.curveHueSat),
    curveLumaSat: curvePoints("curveLumaSat", source.curveLumaSat),
    qualifierEnabled: booleanOr(
      source.qualifierEnabled,
      DEFAULT_COLOR_QUALIFIER.qualifierEnabled,
    ),
    hueCenter:
      ((finiteOr(source.hueCenter, DEFAULT_COLOR_QUALIFIER.hueCenter) % 1) + 1) % 1,
    hueWidth: clamp(
      finiteOr(source.hueWidth, DEFAULT_COLOR_QUALIFIER.hueWidth),
      0,
      1,
    ),
    hueSoftLo: clamp(
      finiteOr(source.hueSoftLo, DEFAULT_COLOR_QUALIFIER.hueSoftLo),
      0,
      0.5,
    ),
    hueSoftHi: clamp(
      finiteOr(source.hueSoftHi, DEFAULT_COLOR_QUALIFIER.hueSoftHi),
      0,
      0.5,
    ),
    satLo: Math.min(satA, satB),
    satHi: Math.max(satA, satB),
    satSoftLo: clamp(
      finiteOr(source.satSoftLo, DEFAULT_COLOR_QUALIFIER.satSoftLo),
      0,
      1,
    ),
    satSoftHi: clamp(
      finiteOr(source.satSoftHi, DEFAULT_COLOR_QUALIFIER.satSoftHi),
      0,
      1,
    ),
    lumaLo: Math.min(lumaA, lumaB),
    lumaHi: Math.max(lumaA, lumaB),
    lumaSoftLo: clamp(
      finiteOr(source.lumaSoftLo, DEFAULT_COLOR_QUALIFIER.lumaSoftLo),
      0,
      1,
    ),
    lumaSoftHi: clamp(
      finiteOr(source.lumaSoftHi, DEFAULT_COLOR_QUALIFIER.lumaSoftHi),
      0,
      1,
    ),
    qualifierInvert: booleanOr(
      source.qualifierInvert,
      DEFAULT_COLOR_QUALIFIER.qualifierInvert,
    ),
    mattePreview: booleanOr(
      source.mattePreview,
      DEFAULT_COLOR_QUALIFIER.mattePreview,
    ),
    lutAssetId:
      typeof source.lutAssetId === "string" && source.lutAssetId.length > 0
        ? source.lutAssetId
        : DEFAULT_COLOR_GRADE_LUT.lutAssetId,
    lutIntensity: clamp(
      finiteOr(source.lutIntensity, DEFAULT_COLOR_GRADE_LUT.lutIntensity),
      0,
      1,
    ),
  };

  const hasWhiteBalance =
    parameters.temperature !== DEFAULT_COLOR_GRADE_PRIMARIES.temperature ||
    parameters.tint !== DEFAULT_COLOR_GRADE_PRIMARIES.tint;
  let variantKey = 0;
  if (
    parameters.exposure !== DEFAULT_COLOR_GRADE_PRIMARIES.exposure ||
    hasWhiteBalance
  ) {
    variantKey |= COLOR_GRADE_SHADER_STAGE.SCENE_LINEAR;
  }
  if (hasWhiteBalance) variantKey |= COLOR_GRADE_SHADER_STAGE.WHITE_BALANCE;
  if (
    [
      parameters.liftR,
      parameters.liftG,
      parameters.liftB,
      parameters.liftMaster,
      parameters.gammaR,
      parameters.gammaG,
      parameters.gammaB,
      parameters.gammaMaster,
      parameters.gainR,
      parameters.gainG,
      parameters.gainB,
      parameters.gainMaster,
      parameters.offsetR,
      parameters.offsetG,
      parameters.offsetB,
      parameters.offsetMaster,
    ].some((value) => value !== 0)
  ) {
    variantKey |= COLOR_GRADE_SHADER_STAGE.WHEELS;
  }
  if (
    parameters.contrast !== DEFAULT_COLOR_GRADE_PRIMARIES.contrast ||
    parameters.kneeSoftness > 0 ||
    (parameters.toeAmount > 0 && parameters.toeSoftness > 0)
  ) {
    variantKey |= COLOR_GRADE_SHADER_STAGE.TONE;
  }
  const curveNames = [
    ...VALUE_CURVE_PARAMETER_NAMES,
    ...MODIFIER_CURVE_PARAMETER_NAMES,
  ];
  if (
    curveNames.some(
      (name) => !isIdentityColorCurve(name, parameters[name] ?? []),
    )
  ) {
    variantKey |= COLOR_GRADE_SHADER_STAGE.CURVES;
  }
  if (
    parameters.saturation !== DEFAULT_COLOR_GRADE_PRIMARIES.saturation ||
    parameters.vibrance !== DEFAULT_COLOR_GRADE_PRIMARIES.vibrance ||
    parameters.hueRotate !== DEFAULT_COLOR_GRADE_PRIMARIES.hueRotate
  ) {
    variantKey |= COLOR_GRADE_SHADER_STAGE.COLOR;
  }
  if (parameters.qualifierEnabled) {
    variantKey |= FUSED_COLOR_GRADE_SHADER_STAGE.QUALIFIER;
    if (parameters.mattePreview) {
      variantKey |= FUSED_COLOR_GRADE_SHADER_STAGE.MATTE_PREVIEW;
    }
  }
  // Compiled whenever a LUT asset is referenced; load state and an animated
  // intensity stay runtime parameters so neither forces a shader rebuild.
  if (parameters.lutAssetId) {
    variantKey |= FUSED_COLOR_GRADE_SHADER_STAGE.LUT;
  }

  return {
    transformId: layer.transformId,
    parameters,
    ditherStrength: Math.max(0, finiteOr(source.ditherStrength, 1)),
    variantKey,
  };
}
