import { describe, expect, it } from "vitest";
import type { MatrixOutputMode } from "../types";
import {
  GLYPH_STROKE_MASKS,
  clamp01,
  colorToVec3,
  composeMatrixOutput,
  glyphIndex,
  paletteGrade,
  sampleRain,
  type Rgba,
} from "../utils/matrixRainMath";

interface CpuVisualCase {
  readonly name: string;
  readonly outputMode: MatrixOutputMode;
  readonly seed: number;
  readonly time: number;
  readonly source: (x: number, y: number) => Rgba;
  readonly signal?: (source: Rgba, x: number, y: number) => number;
}

const WIDTH = 24;
const HEIGHT = 14;
const PALETTE = {
  shadow: colorToVec3("#003b00"),
  body: colorToVec3("#00c21f"),
  bright: colorToVec3("#7dff97"),
};
const HEAD = colorToVec3("#d6ffe4");
const BLACK = colorToVec3("#000000");

function circleAlpha(x: number, y: number): number {
  const dx = x - WIDTH / 2;
  const dy = y - HEIGHT / 2;
  return dx * dx + dy * dy <= 25 ? 1 : 0;
}

const CASES: readonly CpuVisualCase[] = [
  {
    name: "white-circle-replace",
    outputMode: "replaceBlack",
    seed: 1,
    time: 1.25,
    source: (x, y) => {
      const a = circleAlpha(x, y);
      return { r: a, g: a, b: a, a: 1 };
    },
  },
  {
    name: "black-circle-on-white",
    outputMode: "replaceBlack",
    seed: 3,
    time: 1.25,
    source: (x, y) => {
      const value = 1 - circleAlpha(x, y);
      return { r: value, g: value, b: value, a: 1 };
    },
    signal: (source) => 1 - (source.r + source.g + source.b) / 3,
  },
  {
    name: "transparent-white-silhouette",
    outputMode: "sourceTinted",
    seed: 1,
    time: 1.25,
    source: (x, y) => {
      const a = circleAlpha(x, y);
      return { r: a, g: a, b: a, a };
    },
    signal: (source) => source.a,
  },
  {
    name: "transparent-black-silhouette",
    outputMode: "matrixOnly",
    seed: 5,
    time: 1.25,
    source: (x, y) => {
      const a = circleAlpha(x, y);
      return { r: 0, g: 0, b: 0, a };
    },
    signal: (source) => source.a,
  },
  {
    name: "fine-line-overlay",
    outputMode: "overlaySource",
    seed: 7,
    time: 2.5,
    source: (x, y) => {
      const line = x === y || x === WIDTH - y - 1 ? 1 : 0;
      return { r: line * 0.7, g: line * 0.7, b: line * 0.7, a: 1 };
    },
  },
  {
    name: "low-contrast-matrix-only",
    outputMode: "matrixOnly",
    seed: 13,
    time: 4,
    source: (x, y) => {
      const value = 0.32 + ((x + y) % 5) * 0.025;
      return { r: value, g: value, b: value, a: 1 };
    },
  },
  {
    name: "moving-feature-overlay",
    outputMode: "overlaySource",
    seed: 29,
    time: 4.5,
    source: (x, y) => {
      const active = x >= 14 && x <= 18 && y >= 4 && y <= 10 ? 1 : 0;
      return { r: 0, g: active * 0.8, b: active * 0.2, a: 1 };
    },
  },
  {
    name: "horizontal-motion",
    outputMode: "overlaySource",
    seed: 37,
    time: 3.2,
    source: (x, y) => {
      const active = y >= 6 && y <= 8 && x >= 8 && x <= 18 ? 1 : 0;
      return { r: active * 0.2, g: active, b: active * 0.35, a: 1 };
    },
  },
  {
    name: "vertical-motion",
    outputMode: "matrixOnly",
    seed: 41,
    time: 3.8,
    source: (x, y) => {
      const active = x >= 10 && x <= 12 && y >= 2 && y <= 11 ? 1 : 0;
      return { r: active, g: active * 0.5, b: active * 0.1, a: 1 };
    },
  },
  {
    name: "sudden-source-cut",
    outputMode: "replaceBlack",
    seed: 53,
    time: 6,
    source: (x, y) => {
      const value = (x + y) % 2 === 0 ? 0.95 : 0.05;
      return { r: value, g: value * 0.4, b: value * 0.1, a: 1 };
    },
  },
];

function popCount(value: number): number {
  let bits = value >>> 0;
  let count = 0;
  while (bits !== 0) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

function signature(testCase: CpuVisualCase): string {
  let hash = 2166136261;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const source = testCase.source(x, y);
      const signal = clamp01(
        testCase.signal
          ? testCase.signal(source, x, y)
          : source.a > 0
            ? (source.r + source.g + source.b) / (3 * source.a)
            : source.a,
      );
      const rain = sampleRain(x, y, testCase.seed, testCase.time, {
        fallSpeed: 8,
        speedVariation: 0.35,
        trailShape: 1.8,
        pulseDensity: 0.7,
        headWidth: 0.1,
        rainStrength: 1,
      });
      const glyph = glyphIndex(x, y, testCase.seed, Math.floor(testCase.time * 3));
      const glyphDensity = popCount(GLYPH_STROKE_MASKS[glyph]) / 8;
      const brightness = clamp01(rain.trail * 0.35 + signal * 0.65);
      const coverage = clamp01(
        brightness * glyphDensity + rain.head * 0.35,
      );
      const grade = paletteGrade(brightness, PALETTE);
      const straight = [
        clamp01(grade[0] + HEAD[0] * rain.head),
        clamp01(grade[1] + HEAD[1] * rain.head),
        clamp01(grade[2] + HEAD[2] * rain.head),
      ] as const;
      const output = composeMatrixOutput(
        testCase.outputMode,
        source,
        straight,
        coverage,
        BLACK,
      );
      for (const channel of [output.r, output.g, output.b, output.a]) {
        hash ^= Math.round(clamp01(channel) * 255);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
  }
  return hash.toString(16).padStart(8, "0");
}

describe("CPU visual regression cases", () => {
  it("keeps representative source/composition signatures stable", () => {
    const signatures = Object.fromEntries(
      CASES.map((testCase) => [testCase.name, signature(testCase)]),
    );

    expect(signatures).toEqual({
      "black-circle-on-white": "241ea85f",
      "fine-line-overlay": "b054063c",
      "horizontal-motion": "2055f057",
      "low-contrast-matrix-only": "406119a5",
      "moving-feature-overlay": "048648b8",
      "sudden-source-cut": "ab47b1e4",
      "transparent-black-silhouette": "400d17d3",
      "transparent-white-silhouette": "f3a813ea",
      "vertical-motion": "86d65711",
      "white-circle-replace": "bb29b665",
    });
  });

  it("is deterministic and seed-sensitive", () => {
    expect(signature(CASES[0])).toBe(signature(CASES[0]));
    expect(signature({ ...CASES[0], seed: 2 })).not.toBe(signature(CASES[0]));
  });
});
