import { Filter, GlProgram, UniformGroup } from "pixi.js";
import {
  DEFAULT_COLOR_GRADE_PRIMARIES,
  V1_AUTHORED_COLOR_MODEL,
  whiteBalanceMatrix,
  type AuthoredColorModelV1,
  type ColorCurveParameterName,
} from "../../../../../core/color";
import { COLOR_GRADE_FRAGMENT, COLOR_GRADE_VERTEX } from "./shader";
import { CurveTextureBaker } from "./curveTextures";
import { livePreviewParamStore } from "../../../../../core/liveParams/livePreviewParamStore";

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
  uLift: { value: Float32Array; type: "vec4<f32>" };
  uGamma: { value: Float32Array; type: "vec4<f32>" };
  uGain: { value: Float32Array; type: "vec4<f32>" };
  uOffset: { value: Float32Array; type: "vec4<f32>" };
};

type ColorGradeUniforms = UniformGroup<ColorGradeUniformDefinitions>;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class ColorGradeFilter extends Filter {
  private readonly curveTextures: CurveTextureBaker;
  private readonly wheelValues = {
    lift: new Float32Array(4),
    gamma: new Float32Array(4),
    gain: new Float32Array(4),
    offset: new Float32Array(4),
  };
  private currentTemperature = DEFAULT_COLOR_GRADE_PRIMARIES.temperature;
  private currentTint = DEFAULT_COLOR_GRADE_PRIMARIES.tint;
  private authoredModel: AuthoredColorModelV1 = V1_AUTHORED_COLOR_MODEL;

  constructor() {
    const curveTextures = new CurveTextureBaker(() => {
      livePreviewParamStore.requestRender();
    });
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
          uLift: { value: new Float32Array(4), type: "vec4<f32>" },
          uGamma: { value: new Float32Array(4), type: "vec4<f32>" },
          uGain: { value: new Float32Array(4), type: "vec4<f32>" },
          uOffset: { value: new Float32Array(4), type: "vec4<f32>" },
        }),
        uCurveTexture: curveTextures.texture.source,
      },
    });
    this.curveTextures = curveTextures;
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

  private setWheelValue(
    wheel: keyof ColorGradeFilter["wheelValues"],
    channel: number,
    value: number,
  ): void {
    this.wheelValues[wheel][channel] = finiteOr(value, 0);
    const uniformName = {
      lift: "uLift",
      gamma: "uGamma",
      gain: "uGain",
      offset: "uOffset",
    }[wheel] as "uLift" | "uGamma" | "uGain" | "uOffset";
    this.uniforms[uniformName].set(this.wheelValues[wheel]);
  }

  public set liftR(value: number) { this.setWheelValue("lift", 0, value); }
  public set liftG(value: number) { this.setWheelValue("lift", 1, value); }
  public set liftB(value: number) { this.setWheelValue("lift", 2, value); }
  public set liftMaster(value: number) { this.setWheelValue("lift", 3, value); }
  public set gammaR(value: number) { this.setWheelValue("gamma", 0, value); }
  public set gammaG(value: number) { this.setWheelValue("gamma", 1, value); }
  public set gammaB(value: number) { this.setWheelValue("gamma", 2, value); }
  public set gammaMaster(value: number) { this.setWheelValue("gamma", 3, value); }
  public set gainR(value: number) { this.setWheelValue("gain", 0, value); }
  public set gainG(value: number) { this.setWheelValue("gain", 1, value); }
  public set gainB(value: number) { this.setWheelValue("gain", 2, value); }
  public set gainMaster(value: number) { this.setWheelValue("gain", 3, value); }
  public set offsetR(value: number) { this.setWheelValue("offset", 0, value); }
  public set offsetG(value: number) { this.setWheelValue("offset", 1, value); }
  public set offsetB(value: number) { this.setWheelValue("offset", 2, value); }
  public set offsetMaster(value: number) { this.setWheelValue("offset", 3, value); }

  private setCurve(name: ColorCurveParameterName, value: unknown): void {
    this.curveTextures.setCurve(name, value);
  }

  public set curveMaster(value: unknown) { this.setCurve("curveMaster", value); }
  public set curveR(value: unknown) { this.setCurve("curveR", value); }
  public set curveG(value: unknown) { this.setCurve("curveG", value); }
  public set curveB(value: unknown) { this.setCurve("curveB", value); }
  public set curveHueHue(value: unknown) { this.setCurve("curveHueHue", value); }
  public set curveHueSat(value: unknown) { this.setCurve("curveHueSat", value); }
  public set curveLumaSat(value: unknown) { this.setCurve("curveLumaSat", value); }

  public override destroy(destroyPrograms?: boolean): void {
    this.curveTextures.destroy();
    super.destroy(destroyPrograms);
  }
}
