import {
  ASC_CDL_GLSL,
  GRADING_GLSL,
  MATRIX_GLSL,
  QUALIFIER_GLSL,
  SRGB_TRANSFER_GLSL,
  TONE_CURVE_GLSL,
} from "../../../../../core/color";
import { FUSED_GRADE_PARAMETER_TEXTURE_WIDTH } from "./fusedColorGradeTextures";
import { COLOR_GRADE_SHADER_STAGE, COLOR_GRADE_VERTEX } from "./shader";
import { FUSED_COLOR_GRADE_SHADER_STAGE } from "./fusedShaderStages";

function uses(variantKey: number, stage: number): boolean {
  return (variantKey & stage) !== 0;
}

function buildGradeBody(variantKey: number, index: number): string {
  const row = `${index}.0`;
  const sections: string[] = [
    `  // Authored Color Grade ${index + 1}`,
    ...(uses(variantKey, FUSED_COLOR_GRADE_SHADER_STAGE.QUALIFIER)
      ? [`  vec3 grade${index}Input = gradingColor;`]
      : []),
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
  if (uses(variantKey, FUSED_COLOR_GRADE_SHADER_STAGE.QUALIFIER)) {
    sections.push(
      `  vec4 grade${index}p10 = vloGradeParam(${row}, 10.0);`,
      `  vec4 grade${index}p11 = vloGradeParam(${row}, 11.0);`,
      `  vec4 grade${index}p12 = vloGradeParam(${row}, 12.0);`,
      `  vec4 grade${index}p13 = vloGradeParam(${row}, 13.0);`,
      `  vec3 grade${index}Hsv = vloRgbToHsv(grade${index}Input);`,
      `  float grade${index}Matte = vloCircularHueWeight(`,
      `    grade${index}Hsv.x, grade${index}p10.w, grade${index}p11.x,`,
      `    grade${index}p11.y, grade${index}p11.z`,
      "  );",
      `  grade${index}Matte *= vloSoftTrapezoid(`,
      `    grade${index}Hsv.y, grade${index}p11.w, grade${index}p12.x,`,
      `    grade${index}p12.y, grade${index}p12.z`,
      "  );",
      `  grade${index}Matte *= vloSoftTrapezoid(`,
      `    dot(grade${index}Input, vec3(0.2126, 0.7152, 0.0722)),`,
      `    grade${index}p12.w, grade${index}p13.x,`,
      `    grade${index}p13.y, grade${index}p13.z`,
      "  );",
      `  grade${index}Matte = mix(`,
      `    grade${index}Matte, 1.0 - grade${index}Matte, grade${index}p10.y`,
      "  );",
      uses(variantKey, FUSED_COLOR_GRADE_SHADER_STAGE.MATTE_PREVIEW)
        ? `  gradingColor = vec3(grade${index}Matte);`
        : `  gradingColor = mix(grade${index}Input, gradingColor, grade${index}Matte);`,
    );
  }
  if (
    uses(variantKey, FUSED_COLOR_GRADE_SHADER_STAGE.LUT) &&
    !uses(variantKey, FUSED_COLOR_GRADE_SHADER_STAGE.MATTE_PREVIEW)
  ) {
    // Creative LUT applies after the qualifier composite (§2.3). Intensity is
    // written as zero while the `.cube` asset is still loading, so the branch
    // also guards against sampling an unbaked atlas region.
    sections.push(
      `  vec4 grade${index}lut = vloGradeParam(${row}, 14.0);`,
      `  if (grade${index}lut.x > 0.0) {`,
      `    vec4 grade${index}lutMin = vloGradeParam(${row}, 15.0);`,
      `    vec4 grade${index}lutScale = vloGradeParam(${row}, 16.0);`,
      `    gradingColor = mix(`,
      `      gradingColor,`,
      `      vloSampleLut3d(`,
      `        gradingColor,`,
      `        grade${index}lut.yzw,`,
      `        vec2(grade${index}lutMin.w, grade${index}lutScale.w),`,
      `        grade${index}lutMin.rgb,`,
      `        grade${index}lutScale.rgb`,
      `      ),`,
      `      grade${index}lut.x`,
      `    );`,
      "  }",
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
  const hasQualifier = variantKeys.some((key) =>
    uses(key, FUSED_COLOR_GRADE_SHADER_STAGE.QUALIFIER),
  );
  // A matte-preview grade replaces its output with the matte, so its LUT
  // stage never renders and must not force the sampler/functions in.
  const hasLut = variantKeys.some(
    (key) =>
      uses(key, FUSED_COLOR_GRADE_SHADER_STAGE.LUT) &&
      !uses(key, FUSED_COLOR_GRADE_SHADER_STAGE.MATTE_PREVIEW),
  );
  const hasActiveGrade = variantKeys.some((key) => key !== 0);
  const matteIndex = variantKeys.findIndex((key) =>
    uses(key, FUSED_COLOR_GRADE_SHADER_STAGE.MATTE_PREVIEW),
  );
  const renderedVariantKeys =
    matteIndex >= 0 ? variantKeys.slice(0, matteIndex + 1) : variantKeys;
  const gradeBodies = renderedVariantKeys.map(buildGradeBody).join("\n");
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
  // Tetrahedral interpolation over a tiled slice atlas: 4 lattice fetches per
  // pixel, exact on lattice points and visibly cleaner than trilinear for
  // saturated grades. Mirrors sampleCubeLut in core/color/cube.ts. All index
  // math stays in floats with normalized texture() reads — like the curve
  // sampling above — because the fragment may compile as GLSL ES 1.00, which
  // has no texelFetch/ivec/integer-modulus.
  const lutFunctions = hasLut
    ? `
vec3 vloLutLattice(
  vec3 corner,
  float lutSize,
  float tilesX,
  float rowOffset,
  vec2 lutTexel
) {
  float x = mod(corner.z, tilesX) * lutSize + corner.x;
  float y = rowOffset + floor(corner.z / tilesX) * lutSize + corner.y;
  return texture(uLutAtlas, vec2(x + 0.5, y + 0.5) * lutTexel).rgb;
}

vec3 vloSampleLut3d(
  vec3 color,
  vec3 lutLayout,
  vec2 lutTexel,
  vec3 domainMin,
  vec3 domainInvScale
) {
  float lutSize = lutLayout.x;
  float tilesX = lutLayout.y;
  float rowOffset = lutLayout.z;
  vec3 normalized = clamp((color - domainMin) * domainInvScale, 0.0, 1.0);
  vec3 position = normalized * (lutSize - 1.0);
  vec3 base = min(floor(position), vec3(lutSize - 2.0));
  vec3 f = position - base;
  vec3 c000 = vloLutLattice(base, lutSize, tilesX, rowOffset, lutTexel);
  vec3 c111 = vloLutLattice(base + vec3(1.0), lutSize, tilesX, rowOffset, lutTexel);
  vec4 weights;
  vec3 cornerA;
  vec3 cornerB;
  if (f.x >= f.y) {
    if (f.y >= f.z) {
      weights = vec4(1.0 - f.x, f.x - f.y, f.y - f.z, f.z);
      cornerA = vec3(1.0, 0.0, 0.0);
      cornerB = vec3(1.0, 1.0, 0.0);
    } else if (f.x >= f.z) {
      weights = vec4(1.0 - f.x, f.x - f.z, f.z - f.y, f.y);
      cornerA = vec3(1.0, 0.0, 0.0);
      cornerB = vec3(1.0, 0.0, 1.0);
    } else {
      weights = vec4(1.0 - f.z, f.z - f.x, f.x - f.y, f.y);
      cornerA = vec3(0.0, 0.0, 1.0);
      cornerB = vec3(1.0, 0.0, 1.0);
    }
  } else if (f.z >= f.y) {
    weights = vec4(1.0 - f.z, f.z - f.y, f.y - f.x, f.x);
    cornerA = vec3(0.0, 0.0, 1.0);
    cornerB = vec3(0.0, 1.0, 1.0);
  } else if (f.z >= f.x) {
    weights = vec4(1.0 - f.y, f.y - f.z, f.z - f.x, f.x);
    cornerA = vec3(0.0, 1.0, 0.0);
    cornerB = vec3(0.0, 1.0, 1.0);
  } else {
    weights = vec4(1.0 - f.y, f.y - f.x, f.x - f.z, f.z);
    cornerA = vec3(0.0, 1.0, 0.0);
    cornerB = vec3(1.0, 1.0, 0.0);
  }
  return weights.x * c000
    + weights.y * vloLutLattice(base + cornerA, lutSize, tilesX, rowOffset, lutTexel)
    + weights.z * vloLutLattice(base + cornerB, lutSize, tilesX, rowOffset, lutTexel)
    + weights.w * c111;
}
`
    : "";

  return `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uGradeParams;
${hasCurves ? "uniform sampler2D uCurveTexture;" : ""}
${hasLut ? "uniform sampler2D uLutAtlas;" : ""}

${SRGB_TRANSFER_GLSL}
${MATRIX_GLSL}
${TONE_CURVE_GLSL}
${GRADING_GLSL}
${ASC_CDL_GLSL}
${hasQualifier ? QUALIFIER_GLSL : ""}

vec4 vloGradeParam(float row, float column) {
  return texture(
    uGradeParams,
    vec2(
      (column + 0.5) / ${FUSED_GRADE_PARAMETER_TEXTURE_WIDTH}.0,
      (row + 0.5) / ${gradeCount}.0
    )
  );
}
${curveFunctions}${lutFunctions}
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
    matteIndex < 0 && hasActiveGrade
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
