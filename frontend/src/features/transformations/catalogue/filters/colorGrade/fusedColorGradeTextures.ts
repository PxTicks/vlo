import { BufferImageSource } from "pixi.js";
import {
  COLOR_CURVE_LUT_HEIGHT,
  COLOR_CURVE_LUT_WIDTH,
  bakeColorCurveLut,
  whiteBalanceMatrix,
} from "../../../../../core/color";
import type { NormalizedColorGradeLayer } from "./fusedColorGradeParameters";

export const FUSED_GRADE_PARAMETER_TEXTURE_WIDTH = 14;

function curveHash(grades: readonly NormalizedColorGradeLayer[]): string {
  return grades
    .flatMap((grade) =>
      Object.entries(grade.parameters)
        .filter(([name]) => name.startsWith("curve"))
        .flatMap(([name, value]) => [name, JSON.stringify(value)]),
    )
    .join("|");
}

function parameterHash(grades: readonly NormalizedColorGradeLayer[]): string {
  return grades
    .map((grade) =>
      JSON.stringify({
        parameters: Object.fromEntries(
          Object.entries(grade.parameters).filter(
            ([name]) => !name.startsWith("curve"),
          ),
        ),
        ditherStrength: grade.ditherStrength,
      }),
    )
    .join("|");
}

export class FusedColorGradeTextures {
  public readonly parameterSource: BufferImageSource;
  public readonly curveSource: BufferImageSource;
  private parameterPixels = new Float32Array(
    FUSED_GRADE_PARAMETER_TEXTURE_WIDTH * 4,
  );
  private curvePixels = new Float32Array(
    COLOR_CURVE_LUT_WIDTH * COLOR_CURVE_LUT_HEIGHT * 4,
  );
  private gradeCount = 1;
  private currentCurveHash = "";
  private currentParameterHash = "";
  private pendingCurveHash: string | null = null;
  private pendingCurveGrades: readonly NormalizedColorGradeLayer[] = [];
  private curveBakeTimer: ReturnType<typeof setTimeout> | null = null;
  private hasBakedCurves = false;
  private readonly onCurveBake?: () => void;

  constructor(onCurveBake?: () => void) {
    this.onCurveBake = onCurveBake;
    this.parameterSource = new BufferImageSource({
      resource: this.parameterPixels,
      width: FUSED_GRADE_PARAMETER_TEXTURE_WIDTH,
      height: 1,
      format: "rgba32float",
      alphaMode: "no-premultiply-alpha",
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
      autoGarbageCollect: true,
      label: "fused-color-grade-parameters",
    });
    this.curveSource = new BufferImageSource({
      resource: this.curvePixels,
      width: COLOR_CURVE_LUT_WIDTH,
      height: COLOR_CURVE_LUT_HEIGHT,
      format: "rgba32float",
      alphaMode: "no-premultiply-alpha",
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
      autoGarbageCollect: true,
      label: "fused-color-grade-curves",
    });
  }

  public update(grades: readonly NormalizedColorGradeLayer[]): void {
    const nextGradeCount = Math.max(1, grades.length);
    const gradeCountChanged = nextGradeCount !== this.gradeCount;
    const nextParameterHash = parameterHash(grades);
    if (gradeCountChanged) {
      this.gradeCount = nextGradeCount;
      this.parameterPixels = new Float32Array(
        FUSED_GRADE_PARAMETER_TEXTURE_WIDTH * this.gradeCount * 4,
      );
      this.parameterSource.resource = this.parameterPixels;
      this.parameterSource.resize(
        FUSED_GRADE_PARAMETER_TEXTURE_WIDTH,
        this.gradeCount,
      );
    }
    if (gradeCountChanged || nextParameterHash !== this.currentParameterHash) {
      this.currentParameterHash = nextParameterHash;
      this.parameterPixels.fill(0);
      grades.forEach((grade, row) => this.writeGradeParameters(grade, row));
      this.parameterSource.update();
    }

    const nextCurveHash = curveHash(grades);
    if (nextCurveHash === this.currentCurveHash) {
      this.cancelPendingCurveBake();
      return;
    }
    if (nextCurveHash === this.pendingCurveHash) return;
    this.pendingCurveHash = nextCurveHash;
    this.pendingCurveGrades = grades;
    if (!this.hasBakedCurves || gradeCountChanged) {
      this.bakePendingCurves(false);
      return;
    }
    if (this.curveBakeTimer !== null) return;
    this.curveBakeTimer = setTimeout(() => {
      this.curveBakeTimer = null;
      this.bakePendingCurves(true);
    }, 16);
  }

  public destroy(): void {
    this.cancelPendingCurveBake();
    this.parameterSource.destroy();
    this.curveSource.destroy();
  }

  private bakePendingCurves(notify: boolean): void {
    if (this.pendingCurveHash === null) return;
    if (this.curveBakeTimer !== null) clearTimeout(this.curveBakeTimer);
    this.curveBakeTimer = null;
    const grades = this.pendingCurveGrades;
    this.currentCurveHash = this.pendingCurveHash;
    this.pendingCurveHash = null;
    this.pendingCurveGrades = [];
    this.curvePixels = new Float32Array(
      COLOR_CURVE_LUT_WIDTH * COLOR_CURVE_LUT_HEIGHT * this.gradeCount * 4,
    );
    grades.forEach((grade, row) => {
      this.curvePixels.set(
        bakeColorCurveLut(grade.parameters),
        row * COLOR_CURVE_LUT_WIDTH * COLOR_CURVE_LUT_HEIGHT * 4,
      );
    });
    this.curveSource.resource = this.curvePixels;
    this.curveSource.resize(
      COLOR_CURVE_LUT_WIDTH,
      COLOR_CURVE_LUT_HEIGHT * this.gradeCount,
    );
    this.curveSource.update();
    this.hasBakedCurves = true;
    if (notify) this.onCurveBake?.();
  }

  private cancelPendingCurveBake(): void {
    if (this.curveBakeTimer !== null) clearTimeout(this.curveBakeTimer);
    this.curveBakeTimer = null;
    this.pendingCurveHash = null;
    this.pendingCurveGrades = [];
  }

  private writeGradeParameters(
    grade: NormalizedColorGradeLayer,
    row: number,
  ): void {
    const parameters = grade.parameters;
    this.write(row, 0, [
      parameters.exposure,
      parameters.contrast,
      parameters.pivot,
      parameters.kneeThreshold,
    ]);
    this.write(row, 1, [
      parameters.kneeSoftness,
      parameters.toeAmount,
      parameters.toeSoftness,
      parameters.saturation,
    ]);
    this.write(row, 2, [
      parameters.vibrance,
      parameters.hueRotate / 360,
      grade.ditherStrength,
      0,
    ]);
    const whiteBalance = whiteBalanceMatrix(
      parameters.temperature,
      parameters.tint,
    );
    this.write(row, 3, [...whiteBalance.slice(0, 3), 0]);
    this.write(row, 4, [...whiteBalance.slice(3, 6), 0]);
    this.write(row, 5, [...whiteBalance.slice(6, 9), 0]);
    this.write(row, 6, [
      parameters.liftR,
      parameters.liftG,
      parameters.liftB,
      parameters.liftMaster,
    ]);
    this.write(row, 7, [
      parameters.gammaR,
      parameters.gammaG,
      parameters.gammaB,
      parameters.gammaMaster,
    ]);
    this.write(row, 8, [
      parameters.gainR,
      parameters.gainG,
      parameters.gainB,
      parameters.gainMaster,
    ]);
    this.write(row, 9, [
      parameters.offsetR,
      parameters.offsetG,
      parameters.offsetB,
      parameters.offsetMaster,
    ]);
    this.write(row, 10, [
      parameters.qualifierEnabled ? 1 : 0,
      parameters.qualifierInvert ? 1 : 0,
      parameters.mattePreview ? 1 : 0,
      parameters.hueCenter,
    ]);
    this.write(row, 11, [
      parameters.hueWidth,
      parameters.hueSoftLo,
      parameters.hueSoftHi,
      parameters.satLo,
    ]);
    this.write(row, 12, [
      parameters.satHi,
      parameters.satSoftLo,
      parameters.satSoftHi,
      parameters.lumaLo,
    ]);
    this.write(row, 13, [
      parameters.lumaHi,
      parameters.lumaSoftLo,
      parameters.lumaSoftHi,
      0,
    ]);
  }

  private write(row: number, column: number, values: readonly number[]): void {
    const offset =
      (row * FUSED_GRADE_PARAMETER_TEXTURE_WIDTH + column) * 4;
    this.parameterPixels.set(values, offset);
  }
}
