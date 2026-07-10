import { BufferImageSource } from "pixi.js";
import {
  COLOR_CURVE_LUT_HEIGHT,
  COLOR_CURVE_LUT_WIDTH,
  bakeColorCurveLut,
  whiteBalanceMatrix,
} from "../../../../../core/color";
import type { NormalizedColorGradeLayer } from "./fusedColorGradeParameters";

export const FUSED_GRADE_PARAMETER_TEXTURE_WIDTH = 10;

function curveHash(grades: readonly NormalizedColorGradeLayer[]): string {
  return grades
    .flatMap((grade) =>
      Object.entries(grade.parameters)
        .filter(([name]) => name.startsWith("curve"))
        .flatMap(([name, value]) => [name, JSON.stringify(value)]),
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

  constructor() {
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
    if (nextGradeCount !== this.gradeCount) {
      this.gradeCount = nextGradeCount;
      this.parameterPixels = new Float32Array(
        FUSED_GRADE_PARAMETER_TEXTURE_WIDTH * this.gradeCount * 4,
      );
      this.parameterSource.resource = this.parameterPixels;
      this.parameterSource.resize(
        FUSED_GRADE_PARAMETER_TEXTURE_WIDTH,
        this.gradeCount,
      );
    } else {
      this.parameterPixels.fill(0);
    }

    grades.forEach((grade, row) => this.writeGradeParameters(grade, row));
    this.parameterSource.update();

    const nextCurveHash = curveHash(grades);
    if (nextCurveHash === this.currentCurveHash) return;
    this.currentCurveHash = nextCurveHash;
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
  }

  public destroy(): void {
    this.parameterSource.destroy();
    this.curveSource.destroy();
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
  }

  private write(row: number, column: number, values: readonly number[]): void {
    const offset =
      (row * FUSED_GRADE_PARAMETER_TEXTURE_WIDTH + column) * 4;
    this.parameterPixels.set(values, offset);
  }
}
