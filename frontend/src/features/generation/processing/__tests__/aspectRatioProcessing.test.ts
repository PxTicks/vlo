import { describe, expect, it } from "vitest";
import {
  buildAspectRatioProcessingPlan,
  deriveTrueDimensionsFromShortEdge,
  findBestStridedDimensions,
  parseAspectRatioParts,
  pythonRound,
  toStrictPositiveInteger,
} from "../aspectRatioProcessing";

describe("pythonRound", () => {
  it("rounds half to even like Python's round()", () => {
    expect(pythonRound(0.5)).toBe(0);
    expect(pythonRound(1.5)).toBe(2);
    expect(pythonRound(2.5)).toBe(2);
    expect(pythonRound(3.5)).toBe(4);
    expect(pythonRound(80.5)).toBe(80);
    expect(pythonRound(81.5)).toBe(82);
  });

  it("rounds non-ties normally", () => {
    expect(pythonRound(1.4)).toBe(1);
    expect(pythonRound(1.6)).toBe(2);
    expect(pythonRound(80.4999)).toBe(80);
  });

  it("handles negative values like Python", () => {
    expect(pythonRound(-0.5)).toBe(0);
    expect(pythonRound(-1.5)).toBe(-2);
    expect(pythonRound(-2.5)).toBe(-2);
    expect(pythonRound(-1.4)).toBe(-1);
  });
});

describe("toStrictPositiveInteger", () => {
  it("accepts positive integers and digit strings", () => {
    expect(toStrictPositiveInteger(720)).toBe(720);
    expect(toStrictPositiveInteger("720")).toBe(720);
    expect(toStrictPositiveInteger(" 720 ")).toBe(720);
  });

  it("rejects floats, zero, negatives, booleans, and junk", () => {
    expect(toStrictPositiveInteger(720.5)).toBeNull();
    expect(toStrictPositiveInteger(0)).toBeNull();
    expect(toStrictPositiveInteger(-1)).toBeNull();
    expect(toStrictPositiveInteger(true)).toBeNull();
    expect(toStrictPositiveInteger("720.5")).toBeNull();
    expect(toStrictPositiveInteger("-720")).toBeNull();
    expect(toStrictPositiveInteger(null)).toBeNull();
    expect(toStrictPositiveInteger(undefined)).toBeNull();
  });
});

describe("parseAspectRatioParts", () => {
  it("parses colon and slash forms", () => {
    expect(parseAspectRatioParts("16:9")).toEqual([16, 9]);
    expect(parseAspectRatioParts("9/16")).toEqual([9, 16]);
    expect(parseAspectRatioParts(" 2.35 : 1 ")).toEqual([2.35, 1]);
  });

  it("rejects malformed and non-positive values", () => {
    expect(parseAspectRatioParts("16")).toBeNull();
    expect(parseAspectRatioParts("0:9")).toBeNull();
    expect(parseAspectRatioParts("16:0")).toBeNull();
    expect(parseAspectRatioParts("16:9:1")).toBeNull();
    expect(parseAspectRatioParts("")).toBeNull();
    expect(parseAspectRatioParts(null)).toBeNull();
    expect(parseAspectRatioParts(undefined)).toBeNull();
  });
});

describe("deriveTrueDimensionsFromShortEdge", () => {
  it("treats the resolution as the short edge", () => {
    expect(deriveTrueDimensionsFromShortEdge("16:9", 720)).toEqual([1280, 720]);
    expect(deriveTrueDimensionsFromShortEdge("9:16", 720)).toEqual([720, 1280]);
    expect(deriveTrueDimensionsFromShortEdge("1:1", 512)).toEqual([512, 512]);
  });

  it("returns null for unparseable ratios", () => {
    expect(deriveTrueDimensionsFromShortEdge("wat", 720)).toBeNull();
  });
});

describe("findBestStridedDimensions", () => {
  it("returns exact dims when the target is already strided", () => {
    const best = findBestStridedDimensions(1280, 720, 16, 2);
    expect(best).not.toBeNull();
    expect(best?.width).toBe(1280);
    expect(best?.height).toBe(720);
    expect(best?.error).toBe(0);
    expect(best?.distortion).toBe(1);
  });

  it("produces stride multiples", () => {
    const best = findBestStridedDimensions(1279, 721, 16, 2);
    expect(best).not.toBeNull();
    expect((best?.width ?? 0) % 16).toBe(0);
    expect((best?.height ?? 0) % 16).toBe(0);
  });

  it("rejects degenerate parameters", () => {
    expect(findBestStridedDimensions(0, 720, 16, 2)).toBeNull();
    expect(findBestStridedDimensions(1280, 0, 16, 2)).toBeNull();
    expect(findBestStridedDimensions(1280, 720, 0, 2)).toBeNull();
    expect(findBestStridedDimensions(1280, 720, 16, -1)).toBeNull();
  });
});

describe("buildAspectRatioProcessingPlan", () => {
  it("builds metadata with strided dims and true-dimension postprocess", () => {
    const { metadata, warnings } = buildAspectRatioProcessingPlan({
      targetAspectRatio: "16:9",
      targetResolution: 720,
    });
    expect(warnings).toEqual([]);
    expect(metadata).not.toBeNull();
    expect(metadata?.enabled).toBe(true);
    expect(metadata?.requested).toEqual({
      aspect_ratio: "16:9",
      resolution: 720,
      width: 1280,
      height: 720,
    });
    expect(metadata?.strided.width).toBe(1280);
    expect(metadata?.strided.height).toBe(720);
    expect(metadata?.strided.stride).toBe(16);
    expect(metadata?.applied_nodes).toEqual([]);
    expect(metadata?.postprocess).toEqual({
      enabled: true,
      mode: "stretch_exact",
      apply_to: "all_visual_outputs",
      target_width: 1280,
      target_height: 720,
    });
  });

  it("warns and returns null without a target aspect ratio", () => {
    const { metadata, warnings } = buildAspectRatioProcessingPlan({
      targetAspectRatio: "  ",
      targetResolution: 720,
    });
    expect(metadata).toBeNull();
    expect(warnings.map((warning) => warning.code)).toEqual([
      "aspect_ratio_processing_missing_target_aspect_ratio",
    ]);
  });

  it("warns and returns null for a non-integer resolution", () => {
    const { metadata, warnings } = buildAspectRatioProcessingPlan({
      targetAspectRatio: "16:9",
      targetResolution: 720.5,
    });
    expect(metadata).toBeNull();
    expect(warnings.map((warning) => warning.code)).toEqual([
      "aspect_ratio_processing_invalid_target_resolution",
    ]);
  });

  it("clamps out-of-range resolutions to the closest allowed value", () => {
    const { metadata, warnings } = buildAspectRatioProcessingPlan({
      targetAspectRatio: "16:9",
      targetResolution: 700,
      config: { resolutions: [480, 720, 1080] },
    });
    expect(warnings.map((warning) => warning.code)).toEqual([
      "aspect_ratio_processing_resolution_clamped",
    ]);
    expect(metadata?.requested.resolution).toBe(720);
  });

  it("resolves clamp ties to the first allowed resolution, like the backend", () => {
    const { metadata } = buildAspectRatioProcessingPlan({
      targetAspectRatio: "1:1",
      targetResolution: 640,
      config: { resolutions: [512, 768] },
    });
    expect(metadata?.requested.resolution).toBe(512);
  });

  it("honours a disabled postprocess config", () => {
    const { metadata } = buildAspectRatioProcessingPlan({
      targetAspectRatio: "16:9",
      targetResolution: 720,
      config: { postprocess: { enabled: false } },
    });
    expect(metadata?.postprocess.enabled).toBe(false);
  });

  it("respects a custom stride", () => {
    const { metadata } = buildAspectRatioProcessingPlan({
      targetAspectRatio: "16:9",
      targetResolution: 720,
      config: { stride: 64 },
    });
    expect(metadata?.strided.stride).toBe(64);
    expect((metadata?.strided.width ?? 0) % 64).toBe(0);
    expect((metadata?.strided.height ?? 0) % 64).toBe(0);
  });
});
