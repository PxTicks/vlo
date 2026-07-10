import {
  buildColorHistograms,
  createReferenceColorGradeEvaluator,
  type ColorGradeHistogramSnapshot,
  type Rgb,
} from "../../../../../core/color";
import type { NormalizedColorGradeLayer } from "./fusedColorGradeParameters";

export interface ColorGradeHistogramAnalysis {
  readonly snapshot: ColorGradeHistogramSnapshot;
  readonly curveInputPixels: Uint8ClampedArray;
}

function writePixel(
  target: Uint8ClampedArray,
  offset: number,
  color: Rgb,
  alpha: number,
): void {
  target[offset] = color[0] * alpha * 255;
  target[offset + 1] = color[1] * alpha * 255;
  target[offset + 2] = color[2] * alpha * 255;
  target[offset + 3] = alpha * 255;
}

export function analyzeColorGradeHistograms(
  pixels: ArrayLike<number>,
  grades: readonly NormalizedColorGradeLayer[],
  requestedTransformIds: ReadonlySet<string>,
): Map<string, ColorGradeHistogramAnalysis> {
  const evaluators = grades.map((grade) =>
    createReferenceColorGradeEvaluator(grade.parameters),
  );
  const samples = new Map<
    string,
    { before: Uint8ClampedArray; after: Uint8ClampedArray }
  >();
  grades.forEach((grade) => {
    if (requestedTransformIds.has(grade.transformId)) {
      samples.set(grade.transformId, {
        before: new Uint8ClampedArray(pixels.length),
        after: new Uint8ClampedArray(pixels.length),
      });
    }
  });

  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    const alpha = Math.max(0, Math.min(1, pixels[offset + 3] / 255));
    if (alpha <= 1e-6) continue;
    let color: Rgb = [
      pixels[offset] / 255 / alpha,
      pixels[offset + 1] / 255 / alpha,
      pixels[offset + 2] / 255 / alpha,
    ];

    for (let gradeIndex = 0; gradeIndex < grades.length; gradeIndex += 1) {
      const grade = grades[gradeIndex];
      const evaluator = evaluators[gradeIndex];
      const beforeCurves = evaluator.beforeCurves(color);
      const afterCurves = evaluator.curves(beforeCurves);
      const sample = samples.get(grade.transformId);
      if (sample) {
        writePixel(sample.before, offset, beforeCurves, alpha);
        writePixel(sample.after, offset, afterCurves, alpha);
      }
      color = evaluator.afterCurves(afterCurves);
    }
  }

  return new Map(
    [...samples].map(([transformId, sample]) => [
      transformId,
      {
        curveInputPixels: sample.before,
        snapshot: {
          before: buildColorHistograms(sample.before),
          after: buildColorHistograms(sample.after),
        },
      },
    ]),
  );
}

export function reanalyzeColorGradeCurves(
  curveInputPixels: Uint8ClampedArray,
  grade: NormalizedColorGradeLayer,
  beforeHistogram = buildColorHistograms(curveInputPixels),
): ColorGradeHistogramSnapshot {
  const evaluator = createReferenceColorGradeEvaluator(grade.parameters);
  const afterPixels = new Uint8ClampedArray(curveInputPixels.length);
  for (let offset = 0; offset + 3 < curveInputPixels.length; offset += 4) {
    const alpha = Math.max(
      0,
      Math.min(1, curveInputPixels[offset + 3] / 255),
    );
    if (alpha <= 1e-6) continue;
    const before: Rgb = [
      curveInputPixels[offset] / 255 / alpha,
      curveInputPixels[offset + 1] / 255 / alpha,
      curveInputPixels[offset + 2] / 255 / alpha,
    ];
    writePixel(afterPixels, offset, evaluator.curves(before), alpha);
  }
  return {
    before: beforeHistogram,
    after: buildColorHistograms(afterPixels),
  };
}
