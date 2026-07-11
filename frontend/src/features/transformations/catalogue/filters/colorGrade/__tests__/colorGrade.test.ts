import { describe, expect, it, vi } from "vitest";
import { V1_AUTHORED_COLOR_MODEL } from "../../../../../../core/color";
import { getEntryByFilterName, isTransformCompatible } from "../../../TransformationRegistry";
import { COLOR_GRADE_FILTER_NAME, colorGradeDefinition } from "../definition";
import {
  COLOR_GRADE_FRAGMENT,
  COLOR_GRADE_SHADER_STAGE,
  buildColorGradeFragment,
} from "../shader";
import { ColorGradeFilter } from "../colorGradeFilter";
import { FusedColorGradeFilter } from "../fusedColorGradeFilter";
import { buildFusedColorGradeFragment } from "../fusedShader";
import { FusedColorGradeTextures } from "../fusedColorGradeTextures";
import { normalizeColorGradeLayer } from "../fusedColorGradeParameters";
import { createAddTransform } from "../../../../hooks/controller/transformFactory";
import { planTransformRender } from "../../../../effectMaskRenderPlan";
import type { MaskBooleanExpression } from "../../../../../../types/TimelineTypes";

describe("Color Grade transformation", () => {
  it("registers a grade that works on clips and adjustment layers", () => {
    const entry = getEntryByFilterName(COLOR_GRADE_FILTER_NAME);
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Color Grade");
    expect(isTransformCompatible(colorGradeDefinition, "video")).toBe(true);
    expect(isTransformCompatible(colorGradeDefinition, "adjustment")).toBe(true);
  });

  it("stores the authored color model outside slider controls", () => {
    expect(colorGradeDefinition.defaultParameters?.colorModel).toEqual(
      V1_AUTHORED_COLOR_MODEL,
    );
    const controls = colorGradeDefinition.uiConfig.groups.flatMap(
      (group) => group.controls,
    );
    expect(controls.filter((control) => control.type === "custom")).toHaveLength(4);
    expect(
      controls
        .filter(
          (control) =>
            control.type === "number" || control.type === "slider",
        )
        .every((control) => control.supportsSpline),
    ).toBe(true);
  });

  it("creates a fully defaulted, serializable grade from the add menu", () => {
    const transform = createAddTransform(COLOR_GRADE_FILTER_NAME, true);
    expect(transform).toMatchObject({
      type: "filter",
      filterName: COLOR_GRADE_FILTER_NAME,
      parameters: {
        colorModel: V1_AUTHORED_COLOR_MODEL,
        exposure: 0,
        contrast: 1,
        saturation: 1,
        ditherStrength: 1,
        liftR: 0,
        gainMaster: 0,
        curveMaster: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    });
    expect(transform?.parameters).not.toHaveProperty("_colorWheels");
    expect(transform?.parameters).not.toHaveProperty("_valueCurves");
    expect(transform?.parameters).not.toHaveProperty("_toneShaping");
    expect(() => JSON.stringify(transform)).not.toThrow();
  });

  it("routes a masked grade through the existing effect-mask pipeline", () => {
    const transform = createAddTransform(COLOR_GRADE_FILTER_NAME, true);
    expect(transform).not.toBeNull();
    if (!transform) return;
    const expression: MaskBooleanExpression = {
      kind: "mask_ref",
      maskId: "grade-window",
    };
    transform.effectMask = {
      enabled: true,
      mode: "composite",
      expression,
    };

    const plan = planTransformRender([transform]);
    expect(plan).toEqual({
      mode: "offscreen",
      steps: [{ transform, resolution: { kind: "masked", expression } }],
    });
  });

  it("fuses linear light, tone, color, dither, and premultiplied-alpha safety", () => {
    expect(COLOR_GRADE_FRAGMENT).toContain("vec3 straight = source.rgb / source.a");
    expect(COLOR_GRADE_FRAGMENT).toContain("vloSrgbToLinear(straight)");
    expect(COLOR_GRADE_FRAGMENT).toContain("linear *= exp2(uExposure)");
    expect(COLOR_GRADE_FRAGMENT).toContain("vloApplyToneCurve");
    expect(COLOR_GRADE_FRAGMENT).toContain("vloApplyLiftGammaGainOffset");
    expect(COLOR_GRADE_FRAGMENT).toContain("vloApplyColorCurves");
    expect(COLOR_GRADE_FRAGMENT).toContain("vloApplySaturationVibranceHue");
    expect(COLOR_GRADE_FRAGMENT).toContain("vloBlueNoise(gl_FragCoord.xy)");
    expect(COLOR_GRADE_FRAGMENT).toContain("encoded * source.a");
  });

  it("compiles untouched grading stages out of the identity shader", () => {
    const identityFragment = buildColorGradeFragment(0);
    expect(identityFragment).not.toContain("#define VLO_USE_CURVES");
    expect(identityFragment).not.toContain("#define VLO_USE_WHEELS");
    expect(identityFragment).not.toContain("#define VLO_USE_TONE");
    expect(identityFragment).not.toContain("#define VLO_USE_COLOR");

    const curveFragment = buildColorGradeFragment(
      COLOR_GRADE_SHADER_STAGE.CURVES,
    );
    expect(curveFragment).toContain("#define VLO_USE_CURVES");
    expect(curveFragment).not.toContain("#define VLO_USE_WHEELS");
  });

  it("selects shader stages from effective non-identity parameters", () => {
    const filter = new ColorGradeFilter();
    expect(filter.shaderVariantKey).toBe(0);

    filter.pivot = 0.7;
    filter.kneeThreshold = 0.8;
    filter.toeAmount = 0.5;
    expect(filter.shaderVariantKey).toBe(0);

    filter.exposure = 1;
    expect(filter.shaderVariantKey).toBe(
      COLOR_GRADE_SHADER_STAGE.SCENE_LINEAR,
    );
    filter.exposure = 0;
    filter.temperature = 10;
    expect(filter.shaderVariantKey).toBe(
      COLOR_GRADE_SHADER_STAGE.SCENE_LINEAR |
        COLOR_GRADE_SHADER_STAGE.WHITE_BALANCE,
    );
    filter.temperature = 0;

    filter.liftR = 0.1;
    expect(filter.shaderVariantKey).toBe(COLOR_GRADE_SHADER_STAGE.WHEELS);
    filter.liftR = 0;
    filter.curveMaster = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ];
    expect(filter.shaderVariantKey).toBe(0);
    filter.curveMaster = [
      { x: 0, y: 0.1 },
      { x: 1, y: 1 },
    ];
    expect(filter.shaderVariantKey).toBe(COLOR_GRADE_SHADER_STAGE.CURVES);
    filter.curveMaster = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(filter.shaderVariantKey).toBe(0);
    filter.destroy();
  });

  it("shares cached programs between equivalent filters", () => {
    const first = new ColorGradeFilter();
    const second = new ColorGradeFilter();
    expect(first.glProgram).toBe(second.glProgram);
    first.destroy();
    second.destroy();
  });

  it("builds one ordered shader for a run of authored grades", () => {
    const fragment = buildFusedColorGradeFragment([
      COLOR_GRADE_SHADER_STAGE.SCENE_LINEAR,
      COLOR_GRADE_SHADER_STAGE.CURVES | COLOR_GRADE_SHADER_STAGE.COLOR,
    ]);
    expect(fragment.match(/Authored Color Grade/g)).toHaveLength(2);
    expect(fragment.indexOf("Authored Color Grade 1")).toBeLessThan(
      fragment.indexOf("Authored Color Grade 2"),
    );
    expect(fragment).toContain("vloApplyColorCurves(gradingColor, 1.0)");

    const filter = new FusedColorGradeFilter();
    filter.grades = [
      { transformId: "a", parameters: { exposure: 1 } },
      { transformId: "b", parameters: { saturation: 0.5 } },
    ];
    expect(filter.gradeCount).toBe(2);
    expect(filter.shaderVariantKeys).toEqual([
      COLOR_GRADE_SHADER_STAGE.SCENE_LINEAR,
      COLOR_GRADE_SHADER_STAGE.COLOR,
    ]);
    filter.destroy();
  });

  it("coalesces interactive curve LUT bakes onto the live render path", () => {
    vi.useFakeTimers();
    const onBake = vi.fn();
    const textures = new FusedColorGradeTextures(onBake);
    textures.update([
      normalizeColorGradeLayer({ transformId: "a", parameters: {} }),
    ]);
    textures.update([
      normalizeColorGradeLayer({
        transformId: "a",
        parameters: {
          curveMaster: [
            { x: 0, y: 0 },
            { x: 1, y: 0.8 },
          ],
        },
      }),
    ]);

    expect(onBake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(onBake).toHaveBeenCalledTimes(1);
    textures.destroy();
    vi.useRealTimers();
  });

  it("accepts repeated property assignment updates used by filter pooling", () => {
    const filter = new ColorGradeFilter();
    filter.exposure = 2;
    filter.temperature = 50;
    filter.tint = -20;
    filter.contrast = 1.25;
    filter.saturation = 0.8;
    filter.hueRotate = 90;
    filter.liftR = 0.1;
    filter.gammaMaster = 0.2;

    const uniforms = (
      filter.resources.filterUniforms as {
        uniforms: Record<string, number | Float32Array>;
      }
    ).uniforms;
    expect(uniforms.uExposure).toBe(2);
    expect(uniforms.uContrast).toBe(1.25);
    expect(uniforms.uSaturation).toBe(0.8);
    expect(uniforms.uHueRotate).toBe(0.25);
    expect(uniforms.uLift).toEqual(new Float32Array([0.1, 0, 0, 0]));
    expect(uniforms.uGamma).toEqual(new Float32Array([0, 0, 0, 0.2]));
    expect(uniforms.uWhiteBalanceRow0).not.toEqual(
      new Float32Array([1, 0, 0]),
    );
  });
});
