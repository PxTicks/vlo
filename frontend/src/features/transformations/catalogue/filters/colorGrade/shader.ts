import {
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

export const COLOR_GRADE_FRAGMENT = `
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

${SRGB_TRANSFER_GLSL}
${MATRIX_GLSL}
${TONE_CURVE_GLSL}
${GRADING_GLSL}

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
  vec3 linear = vloSrgbToLinear(straight);
  linear = vloApplyMatrixRows(
    linear,
    uWhiteBalanceRow0,
    uWhiteBalanceRow1,
    uWhiteBalanceRow2
  );
  linear *= exp2(uExposure);

  vec3 gradingColor = vloLinearToSrgb(linear);
  gradingColor = vloApplyToneCurve(
    gradingColor,
    uContrast,
    uPivot,
    uKneeThreshold,
    uKneeSoftness,
    uToeAmount,
    uToeSoftness
  );
  gradingColor = vloApplySaturationVibranceHue(
    gradingColor,
    uSaturation,
    uVibrance,
    uHueRotate
  );

  float dither = vloBlueNoise(gl_FragCoord.xy) * (uDitherStrength / 255.0);
  vec3 encoded = clamp(gradingColor + vec3(dither), 0.0, 1.0);
  finalColor = vec4(encoded * source.a, source.a);
}
`;

