import { Filter, GlProgram, UniformGroup } from "pixi.js";
import {
  DEFAULT_COLOR_GRADE_PRIMARIES,
  V1_AUTHORED_COLOR_MODEL,
  whiteBalanceMatrix,
  type AuthoredColorModelV1,
} from "../../../../../core/color";
import { COLOR_GRADE_FRAGMENT, COLOR_GRADE_VERTEX } from "./shader";

const SHARED_COLOR_GRADE_PROGRAM = GlProgram.from({
  vertex: COLOR_GRADE_VERTEX,
  fragment: COLOR_GRADE_FRAGMENT,
  name: "color-grade-filter",
});

type ColorGradeUniformDefinitions = {
  uExposure: { value: number; type: "f32" };
  uWhiteBalanceRow0: { value: Float32Array; type: "vec3<f32>" };
  uWhiteBalanceRow1: { value: Float32Array; type: "vec3<f32>" };
  uWhiteBalanceRow2: { value: Float32Array; type: "vec3<f32>" };
  uContrast: { value: number; type: "f32" };
  uPivot: { value: number; type: "f32" };
  uKneeThreshold: { value: number; type: "f32" };
  uKneeSoftness: { value: number; type: "f32" };
  uToeAmount: { value: number; type: "f32" };
  uToeSoftness: { value: number; type: "f32" };
  uSaturation: { value: number; type: "f32" };
  uVibrance: { value: number; type: "f32" };
  uHueRotate: { value: number; type: "f32" };
  uDitherStrength: { value: number; type: "f32" };
};

type ColorGradeUniforms = UniformGroup<ColorGradeUniformDefinitions>;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class ColorGradeFilter extends Filter {
  private currentTemperature = DEFAULT_COLOR_GRADE_PRIMARIES.temperature;
  private currentTint = DEFAULT_COLOR_GRADE_PRIMARIES.tint;
  private authoredModel: AuthoredColorModelV1 = V1_AUTHORED_COLOR_MODEL;

  constructor() {
    super({
      glProgram: SHARED_COLOR_GRADE_PROGRAM,
      resources: {
        filterUniforms: new UniformGroup<ColorGradeUniformDefinitions>({
          uExposure: { value: DEFAULT_COLOR_GRADE_PRIMARIES.exposure, type: "f32" },
          uWhiteBalanceRow0: {
            value: new Float32Array([1, 0, 0]),
            type: "vec3<f32>",
          },
          uWhiteBalanceRow1: {
            value: new Float32Array([0, 1, 0]),
            type: "vec3<f32>",
          },
          uWhiteBalanceRow2: {
            value: new Float32Array([0, 0, 1]),
            type: "vec3<f32>",
          },
          uContrast: { value: DEFAULT_COLOR_GRADE_PRIMARIES.contrast, type: "f32" },
          uPivot: { value: DEFAULT_COLOR_GRADE_PRIMARIES.pivot, type: "f32" },
          uKneeThreshold: {
            value: DEFAULT_COLOR_GRADE_PRIMARIES.kneeThreshold,
            type: "f32",
          },
          uKneeSoftness: {
            value: DEFAULT_COLOR_GRADE_PRIMARIES.kneeSoftness,
            type: "f32",
          },
          uToeAmount: { value: DEFAULT_COLOR_GRADE_PRIMARIES.toeAmount, type: "f32" },
          uToeSoftness: {
            value: DEFAULT_COLOR_GRADE_PRIMARIES.toeSoftness,
            type: "f32",
          },
          uSaturation: {
            value: DEFAULT_COLOR_GRADE_PRIMARIES.saturation,
            type: "f32",
          },
          uVibrance: { value: DEFAULT_COLOR_GRADE_PRIMARIES.vibrance, type: "f32" },
          uHueRotate: { value: 0, type: "f32" },
          uDitherStrength: { value: 1, type: "f32" },
        }),
      },
    });
  }

  private get uniforms(): ColorGradeUniforms["uniforms"] {
    return (this.resources.filterUniforms as ColorGradeUniforms).uniforms;
  }

  private updateWhiteBalance(): void {
    const matrix = whiteBalanceMatrix(this.currentTemperature, this.currentTint);
    this.uniforms.uWhiteBalanceRow0.set(matrix.slice(0, 3));
    this.uniforms.uWhiteBalanceRow1.set(matrix.slice(3, 6));
    this.uniforms.uWhiteBalanceRow2.set(matrix.slice(6, 9));
  }

  public set colorModel(value: AuthoredColorModelV1) {
    if (value?.version === 1 && value.gradingSpace === "srgb-rec709") {
      this.authoredModel = value;
    }
  }

  public get colorModel(): AuthoredColorModelV1 {
    return this.authoredModel;
  }

  public set exposure(value: number) {
    this.uniforms.uExposure = finiteOr(value, 0);
  }

  public set temperature(value: number) {
    this.currentTemperature = finiteOr(value, 0);
    this.updateWhiteBalance();
  }

  public set tint(value: number) {
    this.currentTint = finiteOr(value, 0);
    this.updateWhiteBalance();
  }

  public set contrast(value: number) {
    this.uniforms.uContrast = Math.max(0, finiteOr(value, 1));
  }

  public set pivot(value: number) {
    this.uniforms.uPivot = finiteOr(value, DEFAULT_COLOR_GRADE_PRIMARIES.pivot);
  }

  public set kneeThreshold(value: number) {
    this.uniforms.uKneeThreshold = finiteOr(value, 1);
  }

  public set kneeSoftness(value: number) {
    this.uniforms.uKneeSoftness = Math.max(0, finiteOr(value, 0));
  }

  public set toeAmount(value: number) {
    this.uniforms.uToeAmount = Math.max(0, Math.min(1, finiteOr(value, 0)));
  }

  public set toeSoftness(value: number) {
    this.uniforms.uToeSoftness = Math.max(0, finiteOr(value, 0));
  }

  public set saturation(value: number) {
    this.uniforms.uSaturation = Math.max(0, finiteOr(value, 1));
  }

  public set vibrance(value: number) {
    this.uniforms.uVibrance = Math.max(-1, Math.min(1, finiteOr(value, 0)));
  }

  public set hueRotate(value: number) {
    this.uniforms.uHueRotate = finiteOr(value, 0) / 360;
  }

  public set ditherStrength(value: number) {
    this.uniforms.uDitherStrength = Math.max(0, finiteOr(value, 1));
  }
}
