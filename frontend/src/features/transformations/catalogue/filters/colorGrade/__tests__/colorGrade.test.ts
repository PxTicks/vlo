import { describe, expect, it } from "vitest";
import { V1_AUTHORED_COLOR_MODEL } from "../../../../../../core/color";
import { getEntryByFilterName, isTransformCompatible } from "../../../TransformationRegistry";
import { COLOR_GRADE_FILTER_NAME, colorGradeDefinition } from "../definition";
import { COLOR_GRADE_FRAGMENT } from "../shader";
import { ColorGradeFilter } from "../colorGradeFilter";
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
    expect(controls.filter((control) => control.type === "custom")).toHaveLength(3);
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
