import {
  Filter,
  GlProgram,
  RenderTexture,
  type FilterSystem,
  type RenderSurface,
  type Texture,
} from "pixi.js";
import { colorGradeHistogramRuntime } from "../../../../../core/color";
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
import { analyzeColorGradeHistograms } from "./colorGradeHistogramAnalysis";
import { HistogramCopyFilter } from "./histogramCopyFilter";

const HISTOGRAM_MAX_DIMENSION = 256;

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

  constructor() {
    const textures = new FusedColorGradeTextures();
    super({
      glProgram: getFusedProgram([0]),
      resources: {
        uGradeParams: textures.parameterSource,
        uCurveTexture: textures.curveSource,
      },
    });
    this.textures = textures;
  }

  public set grades(value: unknown) {
    if (!Array.isArray(value)) {
      this.normalizedGrades = [];
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
    const unchanged =
      nextGrades.length === this.normalizedGrades.length &&
      nextGrades.every((grade, index) => grade === this.normalizedGrades[index]);
    this.normalizedGrades = nextGrades;
    const activeIds = new Set(nextGrades.map((grade) => grade.transformId));
    this.gradeCache.forEach((_cached, transformId) => {
      if (!activeIds.has(transformId)) this.gradeCache.delete(transformId);
    });
    if (!unchanged) this.textures.update(this.normalizedGrades);
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
    this.glProgram = getFusedProgram(this.shaderVariantKeys);
    super.apply(filterManager, input, output, clearMode);
  }

  public override destroy(): void {
    this.histogramCopyFilter.destroy();
    this.histogramTexture?.destroy(true);
    this.histogramTexture = null;
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
    const snapshots = analyzeColorGradeHistograms(
      pixels,
      this.normalizedGrades,
      new Set(dueTransformIds),
    );
    snapshots.forEach((snapshot, transformId) => {
      colorGradeHistogramRuntime.publish(transformId, snapshot);
    });
  }
}
