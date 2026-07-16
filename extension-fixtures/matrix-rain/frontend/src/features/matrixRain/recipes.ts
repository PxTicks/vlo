import type { MatrixRainParameters } from "./types";

export interface MatrixRainRecipe {
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Partial<MatrixRainParameters>>;
  readonly followWith?: {
    readonly filterName: "BloomFilter";
    readonly parameters: Readonly<{ strength: number; quality: number }>;
  };
}

/** Documented starting points; merge one over the shipped defaults. */
export const MATRIX_RAIN_RECIPES = {
  classic: {
    label: "Classic Matrix",
    description: "Balanced green replacement with readable source structure.",
    parameters: {},
  },
  sourceBoundEdges: {
    label: "Source-bound Edges",
    description: "Suppress ambient streams and emit rain primarily from edges.",
    parameters: {
      signalMode: "edge",
      sourceCoupling: 1,
      ambientSpawn: 0,
      trailDensity: 0.42,
      contrast: 1.2,
    },
  },
  ghostOverlay: {
    label: "Ghost Overlay",
    description: "Cool, restrained rain composited over the original source.",
    parameters: {
      outputMode: "overlaySource",
      bodyColor: "#20d9c2",
      rainStrength: 0.7,
      headIntensity: 1.2,
      ambientSpawn: 0.03,
    },
  },
  bloomHeads: {
    label: "Bloom Heads",
    description: "Transparent glyphs with bright heads prepared for native Bloom.",
    parameters: {
      outputMode: "matrixOnly",
      rainStrength: 0.8,
      headIntensity: 3,
      contrast: 1.25,
      size: 12,
      ambientSpawn: 0.04,
    },
    followWith: {
      filterName: "BloomFilter",
      parameters: { strength: 2.5, quality: 4 },
    },
  },
} as const satisfies Readonly<Record<string, MatrixRainRecipe>>;
