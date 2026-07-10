import {
  ASC_CDL_GLSL,
  GRADING_GLSL,
  MATRIX_GLSL,
  SRGB_TRANSFER_GLSL,
  TONE_CURVE_GLSL,
} from "../../../../../core/color";
import { FUSED_GRADE_PARAMETER_TEXTURE_WIDTH } from "./fusedColorGradeTextures";
import { COLOR_GRADE_SHADER_STAGE, COLOR_GRADE_VERTEX } from "./shader";

function uses(variantKey: number, stage: number): boolean {
  return (variantKey & stage) !== 0;
}

function buildGradeBody(variantKey: number, index: number): string {
  const row = `${index}.0`;
  const sections: string[] = [
    `  // Authored Color Grade ${index + 1}`,
    `  vec4 grade${index}p0 = vloGradeParam(${row}, 0.0);`,
  ];
  if (
    uses(variantKey, COLOR_GRADE_SHADER_STAGE.TONE) ||
    uses(variantKey, COLOR_GRADE_SHADER_STAGE.COLOR)
  ) {
    sections.push(`  vec4 grade${index}p1 = vloGradeParam(${row}, 1.0);`);
  }
  if (uses(variantKey, COLOR_GRADE_SHADER_STAGE.COLOR)) {
    sections.push(`  vec4 grade${index}p2 = vloGradeParam(${row}, 2.0);`);
  }

  if (uses(variantKey, COLOR_GRADE_SHADER_STAGE.SCENE_LINEAR)) {
    sections.push(`  vec3 linear${index} = vloSrgbToLinear(gradingColor);`);
    if (uses(variantKey, COLOR_GRADE_SHADER_STAGE.WHITE_BALANCE)) {
      sections.push(
        `  linear${index} = vloApplyMatrixRows(`,
        `    linear${index},`,
        `    vloGradeParam(${row}, 3.0).rgb,`,
        `    vloGradeParam(${row}, 4.0).rgb,`,
        `    vloGradeParam(${row}, 5.0).rgb`,
        "  );",
      );
    }
    sections.push(
      `  linear${index} *= exp2(grade${index}p0.x);`,
      `  gradingColor = vloLinearToSrgb(linear${index});`,
    );
  }
  if (uses(variantKey, COLOR_GRADE_SHADER_STAGE.WHEELS)) {
    sections.push(
      "  gradingColor = vloApplyLiftGammaGainOffset(",
      "    gradingColor,",
      `    vloGradeParam(${row}, 6.0),`,
      `    vloGradeParam(${row}, 7.0),`,
      `    vloGradeParam(${row}, 8.0),`,
      `    vloGradeParam(${row}, 9.0)`,
      "  );",
    );
  }
  if (uses(variantKey, COLOR_GRADE_SHADER_STAGE.TONE)) {
    sections.push(
      "  gradingColor = vloApplyToneCurve(",
      "    gradingColor,",
      `    grade${index}p0.y,`,
      `    grade${index}p0.z,`,
      `    grade${index}p0.w,`,
      `    grade${index}p1.x,`,
      `    grade${index}p1.y,`,
      `    grade${index}p1.z`,
      "  );",
    );
  }
  if (uses(variantKey, COLOR_GRADE_SHADER_STAGE.CURVES)) {
    sections.push(
      `  gradingColor = vloApplyColorCurves(gradingColor, ${row});`,
    );
  }
  if (uses(variantKey, COLOR_GRADE_SHADER_STAGE.COLOR)) {
    sections.push(
      "  gradingColor = vloApplySaturationVibranceHue(",
      "    gradingColor,",
      `    grade${index}p1.w,`,
      `    grade${index}p2.x,`,
      `    grade${index}p2.y`,
      "  );",
    );
  }
  return sections.join("\n");
}

export function buildFusedColorGradeFragment(
  variantKeys: readonly number[],
): string {
  const gradeCount = Math.max(1, variantKeys.length);
  const hasCurves = variantKeys.some((key) =>
    uses(key, COLOR_GRADE_SHADER_STAGE.CURVES),
  );
  const hasActiveGrade = variantKeys.some((key) => key !== 0);
  const gradeBodies = variantKeys.map(buildGradeBody).join("\n");
  const curveFunctions = hasCurves
    ? `
vec4 vloSampleCurveRow(float inputValue, float row) {
  float scaled = clamp(inputValue, 0.0, 1.0) * 1023.0;
  float leftIndex = floor(scaled);
  float rightIndex = min(1023.0, leftIndex + 1.0);
  float amount = scaled - leftIndex;
  float atlasHeight = ${gradeCount * 2}.0;
  vec4 leftSample = texture(
    uCurveTexture,
    vec2((leftIndex + 0.5) / 1024.0, (row + 0.5) / atlasHeight)
  );
  vec4 rightSample = texture(
    uCurveTexture,
    vec2((rightIndex + 0.5) / 1024.0, (row + 0.5) / atlasHeight)
  );
  return mix(leftSample, rightSample, amount);
}

float vloApplyValueCurve(float inputValue, float mappedValue) {
  float boundedInput = clamp(inputValue, 0.0, 1.0);
  return inputValue + mappedValue - boundedInput;
}

vec3 vloApplyColorCurves(vec3 color, float gradeIndex) {
  float valueRow = gradeIndex * 2.0;
  float modifierRow = valueRow + 1.0;
  color = vec3(
    vloApplyValueCurve(color.r, vloSampleCurveRow(color.r, valueRow).r),
    vloApplyValueCurve(color.g, vloSampleCurveRow(color.g, valueRow).r),
    vloApplyValueCurve(color.b, vloSampleCurveRow(color.b, valueRow).r)
  );
  color = vec3(
    vloApplyValueCurve(color.r, vloSampleCurveRow(color.r, valueRow).g),
    vloApplyValueCurve(color.g, vloSampleCurveRow(color.g, valueRow).b),
    vloApplyValueCurve(color.b, vloSampleCurveRow(color.b, valueRow).a)
  );

  vec3 hsv = vloRgbToHsv(color);
  float originalHue = hsv.x;
  vec4 hueCurves = vloSampleCurveRow(originalHue, modifierRow);
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float lumaSat = vloSampleCurveRow(luma, modifierRow).b;
  hsv.x = fract(hsv.x + hueCurves.r);
  float adjustedSaturation = hsv.y * max(0.0, 1.0 + hueCurves.g + lumaSat);
  hsv.y = clamp(adjustedSaturation, 0.0, max(1.0, hsv.y));
  return vloHsvToRgb(hsv);
}
`
    : "";

  return `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uGradeParams;
${hasCurves ? "uniform sampler2D uCurveTexture;" : ""}

${SRGB_TRANSFER_GLSL}
${MATRIX_GLSL}
${TONE_CURVE_GLSL}
${GRADING_GLSL}
${ASC_CDL_GLSL}

vec4 vloGradeParam(float row, float column) {
  return texture(
    uGradeParams,
    vec2(
      (column + 0.5) / ${FUSED_GRADE_PARAMETER_TEXTURE_WIDTH}.0,
      (row + 0.5) / ${gradeCount}.0
    )
  );
}
${curveFunctions}
float vloDitherHash(vec2 position) {
  vec3 p3 = fract(vec3(position.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

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

  vec3 gradingColor = source.rgb / source.a;
${gradeBodies}
  float ditherStrength = ${
    hasActiveGrade
      ? `vloGradeParam(${variantKeys.length - 1}.0, 2.0).z`
      : "0.0"
  };
  float dither = vloBlueNoise(gl_FragCoord.xy) * (ditherStrength / 255.0);
  vec3 encoded = clamp(gradingColor + vec3(dither), 0.0, 1.0);
  finalColor = vec4(encoded * source.a, source.a);
}
`;
}

export const FUSED_COLOR_GRADE_VERTEX = COLOR_GRADE_VERTEX;
