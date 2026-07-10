import {
  Filter,
  GlProgram,
  UniformGroup,
  type FilterSystem,
  type RenderSurface,
  type Texture,
} from "pixi.js";
import {
  DEFAULT_COLOR_GRADE_PRIMARIES,
  V1_AUTHORED_COLOR_MODEL,
  whiteBalanceMatrix,
  type AuthoredColorModelV1,
  type ColorCurveParameterName,
} from "../../../../../core/color";
import {
  COLOR_GRADE_SHADER_STAGE,
  COLOR_GRADE_VERTEX,
  buildColorGradeFragment,
} from "./shader";
import { CurveTextureBaker } from "./curveTextures";
import { livePreviewParamStore } from "../../../../../core/liveParams/livePreviewParamStore";

const COLOR_GRADE_PROGRAM_CACHE = new Map<number, GlProgram>();

function getColorGradeProgram(variantKey: number): GlProgram {
  const cached = COLOR_GRADE_PROGRAM_CACHE.get(variantKey);
  if (cached) return cached;
  const program = GlProgram.from({
    vertex: COLOR_GRADE_VERTEX,
    fragment: buildColorGradeFragment(variantKey),
    name: `color-grade-filter-${variantKey}`,
  });
  COLOR_GRADE_PROGRAM_CACHE.set(variantKey, program);
  return program;
}

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
  private currentExposure = DEFAULT_COLOR_GRADE_PRIMARIES.exposure;
  private currentContrast = DEFAULT_COLOR_GRADE_PRIMARIES.contrast;
  private currentKneeSoftness = DEFAULT_COLOR_GRADE_PRIMARIES.kneeSoftness;
  private currentToeAmount = DEFAULT_COLOR_GRADE_PRIMARIES.toeAmount;
  private currentToeSoftness = DEFAULT_COLOR_GRADE_PRIMARIES.toeSoftness;
  private currentSaturation = DEFAULT_COLOR_GRADE_PRIMARIES.saturation;
  private currentVibrance = DEFAULT_COLOR_GRADE_PRIMARIES.vibrance;
  private currentHueRotate = DEFAULT_COLOR_GRADE_PRIMARIES.hueRotate;
  private authoredModel: AuthoredColorModelV1 = V1_AUTHORED_COLOR_MODEL;

  constructor() {
    const curveTextures = new CurveTextureBaker(() => {
      livePreviewParamStore.requestRender();
    });
    super({
      glProgram: getColorGradeProgram(0),
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

  public get shaderVariantKey(): number {
    let key = 0;
    const hasWhiteBalance =
      this.currentTemperature !== DEFAULT_COLOR_GRADE_PRIMARIES.temperature ||
      this.currentTint !== DEFAULT_COLOR_GRADE_PRIMARIES.tint;
    if (
      this.currentExposure !== DEFAULT_COLOR_GRADE_PRIMARIES.exposure ||
      hasWhiteBalance
    ) {
      key |= COLOR_GRADE_SHADER_STAGE.SCENE_LINEAR;
    }
    if (hasWhiteBalance) key |= COLOR_GRADE_SHADER_STAGE.WHITE_BALANCE;
    if (
      Object.values(this.wheelValues).some((wheel) =>
        wheel.some((value) => value !== 0),
      )
    ) {
      key |= COLOR_GRADE_SHADER_STAGE.WHEELS;
    }
    if (
      this.currentContrast !== DEFAULT_COLOR_GRADE_PRIMARIES.contrast ||
      this.currentKneeSoftness > 0 ||
      (this.currentToeAmount > 0 && this.currentToeSoftness > 0)
    ) {
      key |= COLOR_GRADE_SHADER_STAGE.TONE;
    }
    if (this.curveTextures.hasActiveCurves) {
      key |= COLOR_GRADE_SHADER_STAGE.CURVES;
    }
    if (
      this.currentSaturation !== DEFAULT_COLOR_GRADE_PRIMARIES.saturation ||
      this.currentVibrance !== DEFAULT_COLOR_GRADE_PRIMARIES.vibrance ||
      this.currentHueRotate !== DEFAULT_COLOR_GRADE_PRIMARIES.hueRotate
    ) {
      key |= COLOR_GRADE_SHADER_STAGE.COLOR;
    }
    return key;
  }

  public override apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean,
  ): void {
    this.glProgram = getColorGradeProgram(this.shaderVariantKey);
    super.apply(filterManager, input, output, clearMode);
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
    this.currentExposure = finiteOr(value, 0);
    this.uniforms.uExposure = this.currentExposure;
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
    this.currentContrast = Math.max(0, finiteOr(value, 1));
    this.uniforms.uContrast = this.currentContrast;
  }

  public set pivot(value: number) {
    this.uniforms.uPivot = finiteOr(value, DEFAULT_COLOR_GRADE_PRIMARIES.pivot);
  }

  public set kneeThreshold(value: number) {
    this.uniforms.uKneeThreshold = finiteOr(value, 1);
  }

  public set kneeSoftness(value: number) {
    this.currentKneeSoftness = Math.max(0, finiteOr(value, 0));
    this.uniforms.uKneeSoftness = this.currentKneeSoftness;
  }

  public set toeAmount(value: number) {
    this.currentToeAmount = Math.max(0, Math.min(1, finiteOr(value, 0)));
    this.uniforms.uToeAmount = this.currentToeAmount;
  }

  public set toeSoftness(value: number) {
    this.currentToeSoftness = Math.max(0, finiteOr(value, 0));
    this.uniforms.uToeSoftness = this.currentToeSoftness;
  }

  public set saturation(value: number) {
    this.currentSaturation = Math.max(0, finiteOr(value, 1));
    this.uniforms.uSaturation = this.currentSaturation;
  }

  public set vibrance(value: number) {
    this.currentVibrance = Math.max(-1, Math.min(1, finiteOr(value, 0)));
    this.uniforms.uVibrance = this.currentVibrance;
  }

  public set hueRotate(value: number) {
    this.currentHueRotate = finiteOr(value, 0);
    this.uniforms.uHueRotate = this.currentHueRotate / 360;
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

  public override destroy(): void {
    this.curveTextures.destroy();
    // Variant programs are shared across all color-grade filter instances.
    super.destroy(false);
  }
}
