import {
  ASC_CDL_GLSL,
  GRADING_GLSL,
  MATRIX_GLSL,
  SRGB_TRANSFER_GLSL,
  TONE_CURVE_GLSL,
} from "../../../../../core/color";

export const COLOR_GRADE_VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(vec2 position) {
  vec2 outputPosition = position * uOutputFrame.zw + uOutputFrame.xy;
  outputPosition.x = outputPosition.x * (2.0 / uOutputTexture.x) - 1.0;
  outputPosition.y = outputPosition.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(outputPosition, 0.0, 1.0);
}

vec2 filterTextureCoord(vec2 position) {
  return position * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition(aPosition);
  vTextureCoord = filterTextureCoord(aPosition);
}
`;

export const COLOR_GRADE_SHADER_STAGE = Object.freeze({
  SCENE_LINEAR: 1 << 0,
  WHITE_BALANCE: 1 << 1,
  WHEELS: 1 << 2,
  TONE: 1 << 3,
  CURVES: 1 << 4,
  COLOR: 1 << 5,
});

export const ALL_COLOR_GRADE_SHADER_STAGES = Object.values(
  COLOR_GRADE_SHADER_STAGE,
).reduce((key, stage) => key | stage, 0);

function variantDefines(variantKey: number): string {
  const definitions: string[] = [];
  for (const [name, stage] of Object.entries(COLOR_GRADE_SHADER_STAGE)) {
    if ((variantKey & stage) !== 0) {
      definitions.push(`#define VLO_USE_${name}`);
    }
  }
  return definitions.join("\n");
}

export function buildColorGradeFragment(variantKey: number): string {
  return `${variantDefines(variantKey)}
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uExposure;
uniform vec3 uWhiteBalanceRow0;
uniform vec3 uWhiteBalanceRow1;
uniform vec3 uWhiteBalanceRow2;
uniform float uContrast;
uniform float uPivot;
uniform float uKneeThreshold;
uniform float uKneeSoftness;
uniform float uToeAmount;
uniform float uToeSoftness;
uniform float uSaturation;
uniform float uVibrance;
uniform float uHueRotate;
uniform float uDitherStrength;
#ifdef VLO_USE_WHEELS
uniform vec4 uLift;
uniform vec4 uGamma;
uniform vec4 uGain;
uniform vec4 uOffset;
#endif
#ifdef VLO_USE_CURVES
uniform sampler2D uCurveTexture;
#endif

${SRGB_TRANSFER_GLSL}
${MATRIX_GLSL}
${TONE_CURVE_GLSL}
${GRADING_GLSL}
${ASC_CDL_GLSL}

#ifdef VLO_USE_CURVES
vec4 vloSampleCurveRow(float inputValue, float row) {
  float scaled = clamp(inputValue, 0.0, 1.0) * 1023.0;
  float leftIndex = floor(scaled);
  float rightIndex = min(1023.0, leftIndex + 1.0);
  float amount = scaled - leftIndex;
  vec4 leftSample = texture(
    uCurveTexture,
    vec2((leftIndex + 0.5) / 1024.0, row)
  );
  vec4 rightSample = texture(
    uCurveTexture,
    vec2((rightIndex + 0.5) / 1024.0, row)
  );
  return mix(leftSample, rightSample, amount);
}

float vloApplyValueCurve(float inputValue, float mappedValue) {
  float boundedInput = clamp(inputValue, 0.0, 1.0);
  return inputValue + mappedValue - boundedInput;
}

vec3 vloApplyColorCurves(vec3 color) {
  color = vec3(
    vloApplyValueCurve(color.r, vloSampleCurveRow(color.r, 0.25).r),
    vloApplyValueCurve(color.g, vloSampleCurveRow(color.g, 0.25).r),
    vloApplyValueCurve(color.b, vloSampleCurveRow(color.b, 0.25).r)
  );
  color = vec3(
    vloApplyValueCurve(color.r, vloSampleCurveRow(color.r, 0.25).g),
    vloApplyValueCurve(color.g, vloSampleCurveRow(color.g, 0.25).b),
    vloApplyValueCurve(color.b, vloSampleCurveRow(color.b, 0.25).a)
  );

  vec3 hsv = vloRgbToHsv(color);
  float originalHue = hsv.x;
  vec4 hueCurves = vloSampleCurveRow(originalHue, 0.75);
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float lumaSat = vloSampleCurveRow(luma, 0.75).b;
  hsv.x = fract(hsv.x + hueCurves.r);
  float adjustedSaturation = hsv.y * max(0.0, 1.0 + hueCurves.g + lumaSat);
  hsv.y = clamp(adjustedSaturation, 0.0, max(1.0, hsv.y));
  return vloHsvToRgb(hsv);
}
#endif

float vloDitherHash(vec2 position) {
  vec3 p3 = fract(vec3(position.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// A high-pass procedural noise field suppresses low-frequency dither energy,
// producing a compact blue-noise approximation without another texture read.
float vloBlueNoise(vec2 position) {
  float center = vloDitherHash(position);
  float neighbors = (
    vloDitherHash(position + vec2(1.0, 0.0))
    + vloDitherHash(position + vec2(-1.0, 0.0))
    + vloDitherHash(position + vec2(0.0, 1.0))
    + vloDitherHash(position + vec2(0.0, -1.0))
  ) * 0.25;
  return (center - neighbors) * 0.5;
}

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  if (source.a <= 0.000001) {
    finalColor = vec4(0.0);
    return;
  }

  // Pixi filter textures are premultiplied. Grade straight RGB to avoid
  // dark/bright fringes, then restore the original alpha convention.
  vec3 straight = source.rgb / source.a;
#ifdef VLO_USE_SCENE_LINEAR
  vec3 linear = vloSrgbToLinear(straight);
#ifdef VLO_USE_WHITE_BALANCE
  linear = vloApplyMatrixRows(
    linear,
    uWhiteBalanceRow0,
    uWhiteBalanceRow1,
    uWhiteBalanceRow2
  );
#endif
  linear *= exp2(uExposure);
  vec3 gradingColor = vloLinearToSrgb(linear);
#else
  vec3 gradingColor = straight;
#endif
#ifdef VLO_USE_WHEELS
  gradingColor = vloApplyLiftGammaGainOffset(
    gradingColor,
    uLift,
    uGamma,
    uGain,
    uOffset
  );
#endif
#ifdef VLO_USE_TONE
  gradingColor = vloApplyToneCurve(
    gradingColor,
    uContrast,
    uPivot,
    uKneeThreshold,
    uKneeSoftness,
    uToeAmount,
    uToeSoftness
  );
#endif
#ifdef VLO_USE_CURVES
  gradingColor = vloApplyColorCurves(gradingColor);
#endif
#ifdef VLO_USE_COLOR
  gradingColor = vloApplySaturationVibranceHue(
    gradingColor,
    uSaturation,
    uVibrance,
    uHueRotate
  );
#endif

  float dither = vloBlueNoise(gl_FragCoord.xy) * (uDitherStrength / 255.0);
  vec3 encoded = clamp(gradingColor + vec3(dither), 0.0, 1.0);
  finalColor = vec4(encoded * source.a, source.a);
}
`;
}

/** Full source retained for shader inspection/golden tests. Runtime uses variants. */
export const COLOR_GRADE_FRAGMENT = buildColorGradeFragment(
  ALL_COLOR_GRADE_SHADER_STAGES,
);
