import { describe, expect, it } from "vitest";
import {
  GLYPH_BITMASKS,
  GLYPH_COUNT,
  colorToVec3,
  columnPhase,
  columnSpacing,
  columnSpeedRandom,
  glyphBit,
  glyphIndex,
  glyphTimeBucket,
  paletteGrade,
  pcgHash,
  positiveMod,
  sampleRain,
  unitFloat,
  type RainParameters,
} from "../utils/matrixRainMath";

const RAIN: RainParameters = {
  fallSpeed: 8,
  speedVariation: 0.35,
  trailShape: 1.8,
  pulseDensity: 0.7,
  headWidth: 0.1,
  rainStrength: 1,
};

describe("pcgHash", () => {
  it("is deterministic and wraps at 32 bits", () => {
    expect(pcgHash(0)).toBe(pcgHash(0));
    for (const value of [0, 1, 2, 1234, 0xffffffff]) {
      const h = pcgHash(value);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("decorrelates adjacent inputs", () => {
    expect(pcgHash(0)).not.toBe(pcgHash(1));
    expect(pcgHash(1)).not.toBe(pcgHash(2));
  });
});

describe("unitFloat", () => {
  it("maps hashes into [0, 1)", () => {
    for (let i = 0; i < 1000; i += 1) {
      const f = unitFloat(pcgHash(i));
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});

describe("column variation", () => {
  it("gives each column a stable phase and speed in [0, 1)", () => {
    for (let col = 0; col < 64; col += 1) {
      const p = columnPhase(col, 1);
      const s = columnSpeedRandom(col, 1);
      expect(columnPhase(col, 1)).toBe(p);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });

  it("does not give every column the same phase", () => {
    const phases = new Set<number>();
    for (let col = 0; col < 32; col += 1) phases.add(columnPhase(col, 1));
    expect(phases.size).toBeGreaterThan(24);
  });

  it("changes with the seed", () => {
    expect(columnPhase(3, 1)).not.toBe(columnPhase(3, 2));
  });
});

describe("glyphs", () => {
  it("defines 16 distinct 25-bit masks", () => {
    expect(GLYPH_BITMASKS).toHaveLength(GLYPH_COUNT);
    expect(new Set(GLYPH_BITMASKS).size).toBe(GLYPH_COUNT);
    for (const mask of GLYPH_BITMASKS) {
      expect(mask).toBeGreaterThanOrEqual(0);
      expect(mask).toBeLessThan(1 << 25);
    }
  });

  it("glyphBit reads the mask consistently", () => {
    for (let g = 0; g < GLYPH_COUNT; g += 1) {
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          const expected = ((GLYPH_BITMASKS[g] >>> (row * 5 + col)) & 1) === 1;
          expect(glyphBit(g, col, row)).toBe(expected);
        }
      }
    }
  });

  it("selects glyphs deterministically within range", () => {
    for (let bucket = 0; bucket < 8; bucket += 1) {
      const gi = glyphIndex(4, 7, 1, bucket);
      expect(gi).toBe(glyphIndex(4, 7, 1, bucket));
      expect(gi).toBeGreaterThanOrEqual(0);
      expect(gi).toBeLessThan(GLYPH_COUNT);
    }
  });

  it("cycles glyphs across time buckets and varies with seed", () => {
    const overBuckets = new Set<number>();
    for (let bucket = 0; bucket < 32; bucket += 1) {
      overBuckets.add(glyphIndex(4, 7, 1, bucket));
    }
    expect(overBuckets.size).toBeGreaterThan(1);
    expect(glyphIndex(4, 7, 1, 3)).not.toBe(glyphIndex(4, 7, 2, 3));
  });

  it("buckets time by floor(seconds * rate)", () => {
    expect(glyphTimeBucket(0, 3)).toBe(0);
    expect(glyphTimeBucket(0.99 / 3, 3)).toBe(0);
    expect(glyphTimeBucket(1.01 / 3, 3)).toBe(1);
    expect(glyphTimeBucket(5, 0)).toBe(0); // rate 0 holds one bucket forever
  });
});

describe("positiveMod", () => {
  it("returns a non-negative remainder", () => {
    expect(positiveMod(-1, 5)).toBe(4);
    expect(positiveMod(7, 5)).toBe(2);
    expect(positiveMod(0, 5)).toBe(0);
  });
});

describe("sampleRain", () => {
  it("is stable for a repeated logical sample", () => {
    const a = sampleRain(3, 10, 1, 2.5, RAIN);
    const b = sampleRain(3, 10, 1, 2.5, RAIN);
    expect(b).toEqual(a);
  });

  it("brightens toward the head and fades monotonically along the trail", () => {
    // Static column (fallSpeed 0) so the head sits at phase*spacing and each
    // cell's brightness is a pure function of its distance from the head.
    const p = { ...RAIN, fallSpeed: 0, speedVariation: 0 };
    const spacing = columnSpacing(p.pulseDensity);
    const headLine = columnPhase(0, 1) * spacing;
    const samples = [];
    for (let row = 0; row < 60; row += 1) {
      const distance = positiveMod(headLine - row, spacing);
      samples.push({ distance, ...sampleRain(0, row, 1, 0, p) });
    }
    samples.sort((a, b) => a.distance - b.distance);

    // Trail brightness never increases as the distance from the head grows.
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i].trail).toBeLessThanOrEqual(samples[i - 1].trail + 1e-9);
    }

    const nearest = samples[0];
    const farthest = samples[samples.length - 1];
    // The cell at the head is strictly brighter, with a strong head term; the
    // farthest cell in the trail is dim with essentially no head.
    expect(nearest.trail).toBeGreaterThan(farthest.trail);
    expect(nearest.head).toBeGreaterThan(farthest.head);
    expect(nearest.head).toBeGreaterThan(0.5);
    expect(farthest.head).toBeLessThan(0.1);
  });

  it("holds still when fall speed is zero (no time dependence)", () => {
    const still: RainParameters = { ...RAIN, fallSpeed: 0 };
    const t0 = sampleRain(2, 5, 1, 0, still);
    const t1 = sampleRain(2, 5, 1, 12.3, still);
    expect(t1).toEqual(t0);
  });

  it("does not make every column identical at one time", () => {
    const trails = new Set<number>();
    for (let col = 0; col < 24; col += 1) {
      trails.add(Number(sampleRain(col, 8, 1, 1.0, RAIN).trail.toFixed(6)));
    }
    expect(trails.size).toBeGreaterThan(1);
  });
});

describe("paletteGrade", () => {
  const palette = {
    shadow: [0, 0.2, 0] as const,
    body: [0, 0.7, 0.1] as const,
    bright: [0.5, 1, 0.6] as const,
  };

  it("returns endpoints at 0 and 1", () => {
    expect(paletteGrade(0, palette)).toEqual([0, 0.2, 0]);
    expect(paletteGrade(1, palette)).toEqual([0.5, 1, 0.6]);
  });

  it("passes through the body color at the midpoint", () => {
    expect(paletteGrade(0.5, palette)).toEqual([0, 0.7, 0.1]);
  });

  it("clamps out-of-range brightness", () => {
    expect(paletteGrade(-1, palette)).toEqual([0, 0.2, 0]);
    expect(paletteGrade(5, palette)).toEqual([0.5, 1, 0.6]);
  });
});

describe("colorToVec3", () => {
  it("parses #RRGGBB into normalized channels", () => {
    expect(colorToVec3("#000000")).toEqual([0, 0, 0]);
    expect(colorToVec3("#ffffff")).toEqual([1, 1, 1]);
    const [r, g, b] = colorToVec3("#00c21f");
    expect(r).toBeCloseTo(0, 5);
    expect(g).toBeCloseTo(0xc2 / 255, 5);
    expect(b).toBeCloseTo(0x1f / 255, 5);
  });
});
