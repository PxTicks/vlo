import {
  DEFAULT_COLOR_GRADE_PRIMARIES,
  MODIFIER_CURVE_PARAMETER_NAMES,
  VALUE_CURVE_PARAMETER_NAMES,
  isIdentityColorCurve,
  normalizeColorGradeParameters,
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

export function normalizeColorGradeLayer(
  layer: ResolvedColorGradeLayer,
): NormalizedColorGradeLayer {
  // `colorModel` and `ditherStrength` are dropped from `parameters` because the
  // texture packer hashes that object by key and expects only shader inputs.
  const {
    colorModel: _colorModel,
    ditherStrength,
    ...parameters
  } = normalizeColorGradeParameters(layer.parameters);

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
    ditherStrength,
    variantKey,
  };
}
