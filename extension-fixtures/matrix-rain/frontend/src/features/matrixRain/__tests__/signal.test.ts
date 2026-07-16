import { describe, expect, it } from "vitest";
import {
  acceptsSourceSpawn,
  accumulate,
  assembleSourceSignal,
  computeMotion,
  rainBodyBrightness,
  shapeSignal,
  sourceSpawnProbability,
  updateRainState,
  type Rgba,
  type SignalWeights,
} from "../utils/matrixRainMath";
import {
  accumulationModeIndex,
  motionModeIndex,
  signalModeIndex,
} from "../utils/parameterValidation";

const WEIGHTS: SignalWeights = {
  lumaWeight: 0.35,
  edgeWeight: 0.85,
  edgeGain: 2,
  alphaEdgeWeight: 0.75,
};

const opaque = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 1 });
const flat = (v: number): Rgba => opaque(v, v, v);

describe("assembleSourceSignal", () => {
  const uniform = (c: Rgba) =>
    assembleSourceSignal("luma", c, c, c, c, c, WEIGHTS);

  it("luma and inverse-luma react to opaque black vs white", () => {
    expect(uniform(flat(1))).toBeCloseTo(1, 6);
    expect(uniform(flat(0))).toBeCloseTo(0, 6);
    // Inverse-luma lets a black silhouette drive the signal.
    const black = flat(0);
    expect(assembleSourceSignal("inverseLuma", black, black, black, black, black, WEIGHTS)).toBeCloseTo(1, 6);
  });

  it("does not turn empty transparency into inverse-luma signal", () => {
    const clear: Rgba = { r: 0, g: 0, b: 0, a: 0 };
    expect(
      assembleSourceSignal(
        "inverseLuma",
        clear,
        clear,
        clear,
        clear,
        clear,
        WEIGHTS,
      ),
    ).toBe(0);
  });

  it("alpha mode reacts to the silhouette regardless of RGB colour", () => {
    // Both a transparent-white and transparent-black silhouette (alpha 1) read
    // the same in alpha mode — the exit criterion for alpha silhouettes.
    const whiteSil = opaque(1, 1, 1);
    const blackSil = opaque(0, 0, 0);
    const clear: Rgba = { r: 0, g: 0, b: 0, a: 0 };
    expect(assembleSourceSignal("alpha", whiteSil, whiteSil, whiteSil, whiteSil, whiteSil, WEIGHTS)).toBe(1);
    expect(assembleSourceSignal("alpha", blackSil, blackSil, blackSil, blackSil, blackSil, WEIGHTS)).toBe(1);
    expect(assembleSourceSignal("alpha", clear, clear, clear, clear, clear, WEIGHTS)).toBe(0);
  });

  it("edge mode responds to a luma gradient, not a flat field", () => {
    const c = flat(0.5);
    expect(assembleSourceSignal("edge", c, c, c, c, c, WEIGHTS)).toBe(0);
    // A cell straddling a dark→bright border has a strong horizontal gradient.
    const edge = assembleSourceSignal(
      "edge",
      c, // center
      flat(0), // left (dark)
      flat(1), // right (bright)
      c, // up
      c, // down
      WEIGHTS,
    );
    expect(edge).toBeGreaterThan(0);
  });

  it("edge mode detects an isolated one-cell feature", () => {
    const background = flat(0);
    expect(
      assembleSourceSignal(
        "edge",
        flat(1),
        background,
        background,
        background,
        background,
        WEIGHTS,
      ),
    ).toBeGreaterThan(0);
  });

  it("alpha-edge mode responds to an alpha silhouette's edge", () => {
    const inside: Rgba = { r: 0, g: 0, b: 0, a: 1 };
    const outside: Rgba = { r: 0, g: 0, b: 0, a: 0 };
    // Center inside, one neighbour outside -> alpha gradient -> signal.
    const s = assembleSourceSignal("alphaEdge", inside, outside, inside, inside, inside, WEIGHTS);
    expect(s).toBeGreaterThan(0);
  });
});

describe("shapeSignal", () => {
  it("rejects signal below threshold and applies gain/gamma", () => {
    expect(shapeSignal(0.02, 0.03, 1.3, 0.9)).toBe(0);
    expect(shapeSignal(1, 0.03, 1.3, 0.9)).toBe(1); // clamps to 1
    const mid = shapeSignal(0.5, 0, 1, 1);
    expect(mid).toBeCloseTo(0.5, 6);
  });
});

describe("computeMotion", () => {
  it("absolute reacts to any change; brightening only to increases", () => {
    expect(computeMotion(0.8, 0.2, "absolute", 0, 1)).toBeCloseTo(0.6, 6);
    expect(computeMotion(0.2, 0.8, "absolute", 0, 1)).toBeCloseTo(0.6, 6);
    expect(computeMotion(0.8, 0.2, "brightening", 0, 1)).toBeCloseTo(0.6, 6);
    // A darkening change produces no brightening motion.
    expect(computeMotion(0.2, 0.8, "brightening", 0, 1)).toBe(0);
  });

  it("is zero for a static signal and respects the threshold", () => {
    expect(computeMotion(0.5, 0.5, "absolute", 0, 3)).toBe(0);
    expect(computeMotion(0.51, 0.5, "absolute", 0.02, 3)).toBe(0); // below threshold
  });
});

describe("accumulate", () => {
  it("combines per mode", () => {
    expect(accumulate("softAdd", 0.5, 0.5)).toBeCloseTo(0.75, 6);
    expect(accumulate("max", 0.5, 0.2)).toBe(0.5);
    expect(accumulate("add", 0.5, 0.7)).toBe(1); // clamps
  });
});

describe("source-conditioned stream spawning", () => {
  it("combines ambient, source, and motion into spawn frequency", () => {
    expect(sourceSpawnProbability(0, 0, 0.08, 0.85, 0.6)).toBeCloseTo(
      0.08,
      6,
    );
    expect(sourceSpawnProbability(1, 0, 0.08, 0.85, 0.6)).toBeCloseTo(
      0.862,
      6,
    );
    expect(sourceSpawnProbability(1, 1, 0.08, 0.85, 0.6)).toBe(1);
  });

  it("makes a stable decision per pulse and increases accepted density", () => {
    const low = Array.from({ length: 2_000 }, (_, pulse) =>
      acceptsSourceSpawn(7, pulse - 1_000, 23, 0.1),
    ).filter(Boolean).length;
    const high = Array.from({ length: 2_000 }, (_, pulse) =>
      acceptsSourceSpawn(7, pulse - 1_000, 23, 0.8),
    ).filter(Boolean).length;

    expect(acceptsSourceSpawn(7, -12, 23, 0.4)).toBe(
      acceptsSourceSpawn(7, -12, 23, 0.4),
    );
    expect(low).toBeGreaterThan(100);
    expect(high).toBeGreaterThan(low * 4);
  });
});

describe("motion-aware injection (updateRainState)", () => {
  const motionParams = {
    trailHalfLife: 0.45,
    baseInjection: 0,
    sourceInfluence: 0.85,
    motionInfluence: 0.6,
    motionMode: "absolute" as const,
    motionThreshold: 0,
    motionGain: 3,
    motionImmediateAmount: 0.75,
    accumulationMode: "softAdd" as const,
  };

  it("injects new activity where motion occurs even off the procedural trail", () => {
    // Procedural trail 0 (so static source injection is gated off), but a strong
    // change (0 -> 1) drives motion injection through the immediate bypass.
    const moved = updateRainState({
      advectedRain: 0,
      currentSignal: 1,
      previousSignal: 0,
      proceduralTrail: 0,
      proceduralHead: 0,
      deltaSeconds: 1 / 30,
      params: motionParams,
    });
    expect(moved.a).toBeGreaterThan(0); // motion recorded in A
    expect(moved.r).toBeGreaterThan(0); // new bright activity injected
  });

  it("applies the overall injection strength", () => {
    const base = {
      advectedRain: 0,
      currentSignal: 1,
      previousSignal: 1,
      proceduralTrail: 1,
      proceduralHead: 0,
      deltaSeconds: 1 / 30,
    };
    const normal = updateRainState({
      ...base,
      params: { ...motionParams, injectionStrength: 1 },
    });
    const reduced = updateRainState({
      ...base,
      params: { ...motionParams, injectionStrength: 0.25 },
    });
    expect(reduced.r).toBeLessThan(normal.r);
    expect(reduced.r).toBeCloseTo(normal.r * 0.25, 6);
  });

  it("does not saturate a static region off the trail", () => {
    // Same bright signal every frame (no motion), procedural trail 0: R stays 0.
    let r = 0;
    for (let i = 0; i < 300; i += 1) {
      r = updateRainState({
        advectedRain: r,
        currentSignal: 1,
        previousSignal: 1,
        proceduralTrail: 0,
        proceduralHead: 0,
        deltaSeconds: 1 / 30,
        params: motionParams,
      }).r;
    }
    expect(r).toBe(0);
  });

  it("rejects both trail injection and the procedural head for an unspawned stream", () => {
    const rejected = updateRainState({
      advectedRain: 0,
      currentSignal: 1,
      previousSignal: 1,
      proceduralTrail: 1,
      proceduralHead: 1,
      streamAccepted: false,
      deltaSeconds: 1 / 30,
      params: motionParams,
    });

    expect(rejected.r).toBe(0);
    expect(rejected.g).toBe(0);
  });

  it("seeds an accepted narrow head when it crossed between samples", () => {
    const crossed = updateRainState({
      advectedRain: 0,
      currentSignal: 1,
      previousSignal: 1,
      proceduralTrail: 0,
      proceduralHead: 0,
      headCrossed: true,
      streamAccepted: true,
      deltaSeconds: 1 / 30,
      params: motionParams,
    });

    expect(crossed.g).toBe(1);
  });

  it("carries an accepted head and damps it faster in dark cells", () => {
    const bright = updateRainState({
      advectedRain: 0.8,
      advectedHead: 0.8,
      currentSignal: 1,
      previousSignal: 1,
      proceduralTrail: 0,
      proceduralHead: 0,
      streamAccepted: false,
      deltaSeconds: 0.5,
      params: { ...motionParams, darkDamping: 2 },
    });
    const dark = updateRainState({
      advectedRain: 0.8,
      advectedHead: 0.8,
      currentSignal: 0,
      previousSignal: 0,
      proceduralTrail: 0,
      proceduralHead: 0,
      streamAccepted: false,
      deltaSeconds: 0.5,
      params: { ...motionParams, darkDamping: 2 },
    });

    expect(bright.g).toBeCloseTo(0.8, 6);
    expect(dark.g).toBeCloseTo(0.4, 6);
    expect(dark.r).toBeCloseTo(bright.r * 0.5, 6);
  });

  it("carries the motion term into the glyph body brightness", () => {
    const state = { r: 0, g: 0, b: 0, a: 0.5 };
    expect(rainBodyBrightness(state, 1, 0.25, 0.15)).toBeCloseTo(0.075, 6);
  });
});

describe("enum indices", () => {
  it("map to their shader integer contract", () => {
    expect(signalModeIndex("luma")).toBe(0);
    expect(signalModeIndex("inverseLuma")).toBe(1);
    expect(signalModeIndex("edge")).toBe(2);
    expect(signalModeIndex("lumaEdge")).toBe(3);
    expect(signalModeIndex("alpha")).toBe(4);
    expect(signalModeIndex("alphaEdge")).toBe(5);
    expect(motionModeIndex("absolute")).toBe(0);
    expect(motionModeIndex("brightening")).toBe(1);
    expect(accumulationModeIndex("softAdd")).toBe(0);
    expect(accumulationModeIndex("max")).toBe(1);
    expect(accumulationModeIndex("add")).toBe(2);
  });
});
