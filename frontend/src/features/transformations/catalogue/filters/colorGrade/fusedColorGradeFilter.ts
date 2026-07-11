import {
  Filter,
  GlProgram,
  RenderTexture,
  type FilterSystem,
  type RenderSurface,
  type Texture,
} from "pixi.js";
import {
  colorGradeHistogramRuntime,
  type ColorGradeHistogramSnapshot,
  type ColorGradeReferenceParameters,
} from "../../../../../core/color";
import { livePreviewParamStore } from "../../../../../core/liveParams/livePreviewParamStore";
import type { ResolvedColorGradeLayer } from "../../filterPreResolution";
import {
  normalizeColorGradeLayer,
  type NormalizedColorGradeLayer,
} from "./fusedColorGradeParameters";
import { FusedColorGradeTextures } from "./fusedColorGradeTextures";
import {
  FUSED_COLOR_GRADE_VERTEX,
  buildFusedColorGradeFragment,
} from "./fusedShader";
import {
  analyzeColorGradeHistograms,
  reanalyzeColorGradeCurves,
} from "./colorGradeHistogramAnalysis";
import { HistogramCopyFilter } from "./histogramCopyFilter";
import { COLOR_GRADE_SHADER_STAGE } from "./shader";

const HISTOGRAM_MAX_DIMENSION = 160;

const CURVE_PARAMETER_NAMES = [
  "curveMaster",
  "curveR",
  "curveG",
  "curveB",
  "curveHueHue",
  "curveHueSat",
  "curveLumaSat",
] as const satisfies readonly (keyof ColorGradeReferenceParameters)[];

const BEFORE_CURVE_PARAMETER_NAMES = [
  "exposure",
  "temperature",
  "tint",
  "contrast",
  "pivot",
  "kneeThreshold",
  "kneeSoftness",
  "toeAmount",
  "toeSoftness",
  "liftR",
  "liftG",
  "liftB",
  "liftMaster",
  "gammaR",
  "gammaG",
  "gammaB",
  "gammaMaster",
  "gainR",
  "gainG",
  "gainB",
  "gainMaster",
  "offsetR",
  "offsetG",
  "offsetB",
  "offsetMaster",
] as const satisfies readonly (keyof ColorGradeReferenceParameters)[];

function parameterSignature(
  parameters: ColorGradeReferenceParameters,
  names: readonly (keyof ColorGradeReferenceParameters)[],
): string {
  return JSON.stringify(names.map((name) => parameters[name]));
}

const FUSED_PROGRAM_CACHE = new Map<string, GlProgram>();

function programKey(variantKeys: readonly number[]): string {
  return variantKeys.length > 0 ? variantKeys.join("-") : "0";
}

function getFusedProgram(variantKeys: readonly number[]): GlProgram {
  const key = programKey(variantKeys);
  const cached = FUSED_PROGRAM_CACHE.get(key);
  if (cached) return cached;
  const shaderKeys = variantKeys.length > 0 ? variantKeys : [0];
  const program = GlProgram.from({
    vertex: FUSED_COLOR_GRADE_VERTEX,
    fragment: buildFusedColorGradeFragment(shaderKeys),
    name: `fused-color-grade-${key}`,
  });
  FUSED_PROGRAM_CACHE.set(key, program);
  return program;
}

export class FusedColorGradeFilter extends Filter {
  private readonly textures: FusedColorGradeTextures;
  private readonly histogramCopyFilter = new HistogramCopyFilter();
  private histogramTexture: RenderTexture | null = null;
  private normalizedGrades: readonly NormalizedColorGradeLayer[] = [];
  private readonly gradeCache = new Map<
    string,
    { signature: string; grade: NormalizedColorGradeLayer }
  >();
  private readonly histogramCache = new Map<
    string,
    {
      curveInputPixels: Uint8ClampedArray;
      snapshot: ColorGradeHistogramSnapshot;
    }
  >();
  private readonly pendingHistogramReanalysis = new Map<
    string,
    {
      grade: NormalizedColorGradeLayer;
      curveInputPixels: Uint8ClampedArray;
      before: ColorGradeHistogramSnapshot["before"];
    }
  >();
  private histogramReanalysisScheduled = false;
  private disposed = false;

  constructor() {
    const textures = new FusedColorGradeTextures(() => {
      livePreviewParamStore.requestRender();
    });
    super({
      glProgram: getFusedProgram([0]),
      resources: {
        uGradeParams: textures.parameterSource,
        uCurveTexture: textures.curveSource,
        uLutAtlas: textures.lutSource,
      },
    });
    this.textures = textures;
  }

  public set grades(value: unknown) {
    if (!Array.isArray(value)) {
      this.normalizedGrades = [];
      this.gradeCache.clear();
      this.histogramCache.clear();
      this.textures.update([]);
      return;
    }
    const nextGrades = value
      .filter(
        (layer): layer is ResolvedColorGradeLayer =>
          typeof layer === "object" &&
          layer !== null &&
          "transformId" in layer &&
          typeof layer.transformId === "string" &&
          "parameters" in layer &&
          typeof layer.parameters === "object" &&
          layer.parameters !== null,
      )
      .map((layer) => {
        const signature = JSON.stringify(layer.parameters) ?? "";
        const cached = this.gradeCache.get(layer.transformId);
        if (cached?.signature === signature) return cached.grade;
        const grade = normalizeColorGradeLayer(layer);
        this.gradeCache.set(layer.transformId, { signature, grade });
        return grade;
      });
    const previousGrades = this.normalizedGrades;
    const unchanged =
      nextGrades.length === this.normalizedGrades.length &&
      nextGrades.every((grade, index) => grade === this.normalizedGrades[index]);
    this.normalizedGrades = nextGrades;
    const activeIds = new Set(nextGrades.map((grade) => grade.transformId));
    this.gradeCache.forEach((_cached, transformId) => {
      if (!activeIds.has(transformId)) this.gradeCache.delete(transformId);
    });
    if (!unchanged) {
      this.updateCachedHistograms(previousGrades, nextGrades);
      this.textures.update(this.normalizedGrades);
    }
  }

  public get gradeCount(): number {
    return this.normalizedGrades.length;
  }

  public get shaderVariantKeys(): readonly number[] {
    return this.normalizedGrades.map((grade) => grade.variantKey);
  }

  public override apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean,
  ): void {
    this.captureDueHistograms(filterManager, input);
    const effectiveVariantKeys = this.normalizedGrades.map((grade) =>
      colorGradeHistogramRuntime.hasSubscription(grade.transformId)
        ? grade.variantKey | COLOR_GRADE_SHADER_STAGE.CURVES
        : grade.variantKey,
    );
    // Compile/link the curve path when its editor becomes visible, before the
    // first drag event. The identity LUT keeps output unchanged while avoiding
    // a shader-variant stall at drag initiation.
    this.glProgram = getFusedProgram(effectiveVariantKeys);
    super.apply(filterManager, input, output, clearMode);
  }

  public override destroy(): void {
    this.disposed = true;
    this.pendingHistogramReanalysis.clear();
    this.histogramCopyFilter.destroy();
    this.histogramTexture?.destroy(true);
    this.histogramTexture = null;
    this.histogramCache.clear();
    this.textures.destroy();
    super.destroy(false);
  }

  private captureDueHistograms(
    filterManager: FilterSystem,
    input: Texture,
  ): void {
    const dueTransformIds = colorGradeHistogramRuntime.getDueTransformIds(
      this.normalizedGrades.map((grade) => grade.transformId),
    );
    if (dueTransformIds.length === 0) return;

    const longestSide = Math.max(input.frame.width, input.frame.height, 1);
    const scale = Math.min(1, HISTOGRAM_MAX_DIMENSION / longestSide);
    const width = Math.max(1, Math.round(input.frame.width * scale));
    const height = Math.max(1, Math.round(input.frame.height * scale));
    if (!this.histogramTexture) {
      this.histogramTexture = RenderTexture.create({
        width,
        height,
        dynamic: true,
        antialias: false,
        scaleMode: "linear",
      });
    } else if (
      this.histogramTexture.width !== width ||
      this.histogramTexture.height !== height
    ) {
      this.histogramTexture.resize(width, height);
    }

    filterManager.applyFilter(
      this.histogramCopyFilter,
      input,
      this.histogramTexture,
      true,
    );
    const pixels = filterManager.renderer.texture.getPixels(
      this.histogramTexture,
    ).pixels;
    const analyses = analyzeColorGradeHistograms(
      pixels,
      this.normalizedGrades,
      new Set(dueTransformIds),
    );
    analyses.forEach((analysis, transformId) => {
      this.histogramCache.set(transformId, analysis);
      colorGradeHistogramRuntime.publish(transformId, analysis.snapshot);
    });
  }

  private updateCachedHistograms(
    previousGrades: readonly NormalizedColorGradeLayer[],
    nextGrades: readonly NormalizedColorGradeLayer[],
  ): void {
    let upstreamChanged = previousGrades.length !== nextGrades.length;

    for (let index = 0; index < nextGrades.length; index += 1) {
      const previous = previousGrades[index];
      const next = nextGrades[index];
      const cache = this.histogramCache.get(next.transformId);

      if (upstreamChanged || !previous || previous.transformId !== next.transformId) {
        this.pendingHistogramReanalysis.delete(next.transformId);
        this.histogramCache.delete(next.transformId);
        colorGradeHistogramRuntime.invalidate(next.transformId);
        upstreamChanged = true;
        continue;
      }
      if (previous === next) continue;

      const beforeCurvesChanged =
        parameterSignature(previous.parameters, BEFORE_CURVE_PARAMETER_NAMES) !==
        parameterSignature(next.parameters, BEFORE_CURVE_PARAMETER_NAMES);
      const curvesChanged =
        parameterSignature(previous.parameters, CURVE_PARAMETER_NAMES) !==
        parameterSignature(next.parameters, CURVE_PARAMETER_NAMES);

      if (beforeCurvesChanged || !cache) {
        this.pendingHistogramReanalysis.delete(next.transformId);
        this.histogramCache.delete(next.transformId);
        colorGradeHistogramRuntime.invalidate(next.transformId);
      } else if (curvesChanged) {
        this.scheduleHistogramReanalysis(next.transformId, {
          grade: next,
          curveInputPixels: cache.curveInputPixels,
          before: cache.snapshot.before,
        });
      } else {
        colorGradeHistogramRuntime.publish(next.transformId, cache.snapshot);
      }

      // Any change to this grade affects the input edge of every later grade.
      upstreamChanged = true;
    }

    const activeIds = new Set(nextGrades.map((grade) => grade.transformId));
    this.histogramCache.forEach((_cache, transformId) => {
      if (!activeIds.has(transformId)) this.histogramCache.delete(transformId);
    });
  }

  private scheduleHistogramReanalysis(
    transformId: string,
    pending: {
      grade: NormalizedColorGradeLayer;
      curveInputPixels: Uint8ClampedArray;
      before: ColorGradeHistogramSnapshot["before"];
    },
  ): void {
    this.pendingHistogramReanalysis.set(transformId, pending);
    if (this.histogramReanalysisScheduled) return;
    this.histogramReanalysisScheduled = true;
    queueMicrotask(() => {
      this.histogramReanalysisScheduled = false;
      if (this.disposed) return;
      const reanalyses = [...this.pendingHistogramReanalysis];
      this.pendingHistogramReanalysis.clear();
      reanalyses.forEach(([pendingTransformId, analysis]) => {
        const currentGrade = this.normalizedGrades.find(
          (grade) => grade.transformId === pendingTransformId,
        );
        if (currentGrade !== analysis.grade) return;
        const snapshot = reanalyzeColorGradeCurves(
          analysis.curveInputPixels,
          analysis.grade,
          analysis.before,
        );
        this.histogramCache.set(pendingTransformId, {
          curveInputPixels: analysis.curveInputPixels,
          snapshot,
        });
        colorGradeHistogramRuntime.publish(pendingTransformId, snapshot);
      });
    });
  }
}
