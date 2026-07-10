import { V1_COLOR_MODEL } from "./model";
import type { Rgb } from "./types";

export interface AscCdlParameters {
  readonly slope: Rgb;
  readonly offset: Rgb;
  readonly power: Rgb;
  readonly saturation: number;
}

export interface LiftGammaGainOffsetParameters {
  readonly lift: Rgb;
  readonly liftMaster: number;
  readonly gamma: Rgb;
  readonly gammaMaster: number;
  readonly gain: Rgb;
  readonly gainMaster: number;
  readonly offset: Rgb;
  readonly offsetMaster: number;
}

export function applyLiftGammaGainOffset(
  color: Rgb,
  parameters: LiftGammaGainOffsetParameters,
): Rgb {
  return color.map((value, channel) => {
    const lifted =
      value + parameters.lift[channel] + parameters.liftMaster;
    const gamma = Math.max(
      0.01,
      1 + parameters.gamma[channel] + parameters.gammaMaster,
    );
    const gained =
      Math.pow(Math.max(lifted, 0), 1 / gamma) *
      Math.max(0, 1 + parameters.gain[channel] + parameters.gainMaster);
    return gained + parameters.offset[channel] + parameters.offsetMaster;
  }) as unknown as Rgb;
}

/** ASC CDL v1.2 SOP followed by Rec.709-luma saturation. */
export function applyAscCdl(color: Rgb, parameters: AscCdlParameters): Rgb {
  const sop = color.map((value, channel) =>
    Math.pow(
      Math.max(value * parameters.slope[channel] + parameters.offset[channel], 0),
      parameters.power[channel],
    ),
  ) as unknown as Rgb;
  const coefficients = V1_COLOR_MODEL.working.lumaCoefficients;
  const luma =
    sop[0] * coefficients[0] +
    sop[1] * coefficients[1] +
    sop[2] * coefficients[2];
  return sop.map(
    (value) => luma + parameters.saturation * (value - luma),
  ) as unknown as Rgb;
}

export const ASC_CDL_GLSL = `
vec3 vloApplyAscCdl(
  vec3 color,
  vec3 slope,
  vec3 offset,
  vec3 power,
  float saturation
) {
  vec3 sop = pow(max(color * slope + offset, vec3(0.0)), power);
  float luma = dot(sop, vec3(0.2126, 0.7152, 0.0722));
  return vec3(luma) + saturation * (sop - vec3(luma));
}

vec3 vloApplyLiftGammaGainOffset(
  vec3 color,
  vec4 lift,
  vec4 gamma,
  vec4 gain,
  vec4 offset
) {
  vec3 lifted = color + lift.rgb + vec3(lift.a);
  vec3 gammaValue = max(vec3(0.01), vec3(1.0) + gamma.rgb + vec3(gamma.a));
  vec3 gained = pow(max(lifted, vec3(0.0)), vec3(1.0) / gammaValue)
    * max(vec3(0.0), vec3(1.0) + gain.rgb + vec3(gain.a));
  return gained + offset.rgb + vec3(offset.a);
}
`;
