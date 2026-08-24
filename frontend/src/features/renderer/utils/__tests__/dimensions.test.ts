import { describe, it, expect } from "vitest";
import {
  deriveTrueDimensionsFromShortEdge,
  getProjectDimensions,
  resolveRenderOutputDimensions,
} from "../dimensions";

describe("getProjectDimensions", () => {
  it("should return correct dimensions for 16:9", () => {
    expect(getProjectDimensions("16:9")).toEqual({ width: 1920, height: 1080 });
  });

  it("should return correct dimensions for 4:3", () => {
    expect(getProjectDimensions("4:3")).toEqual({ width: 1440, height: 1080 });
  });

  it("should return correct dimensions for 1:1", () => {
    expect(getProjectDimensions("1:1")).toEqual({ width: 1080, height: 1080 });
  });

  it("should return correct dimensions for 3:4", () => {
    expect(getProjectDimensions("3:4")).toEqual({ width: 810, height: 1080 });
  });

  it("should return correct dimensions for 9:16", () => {
    expect(getProjectDimensions("9:16")).toEqual({ width: 608, height: 1080 });
  });

  it("should return default 16:9 dimensions for unknown ratio", () => {
    // @ts-expect-error Testing invalid input
    expect(getProjectDimensions("invalid")).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});

describe("deriveTrueDimensionsFromShortEdge", () => {
  it("returns true landscape dimensions from the short edge", () => {
    expect(deriveTrueDimensionsFromShortEdge("16:9", 1080)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("returns true portrait dimensions from the short edge", () => {
    expect(deriveTrueDimensionsFromShortEdge("9:16", 1080)).toEqual({
      width: 1080,
      height: 1920,
    });
  });

  it("returns square dimensions from the short edge", () => {
    expect(deriveTrueDimensionsFromShortEdge("1:1", 720)).toEqual({
      width: 720,
      height: 720,
    });
  });
});

describe("resolveRenderOutputDimensions", () => {
  const ratios = ["16:9", "4:3", "1:1", "3:4", "9:16"] as const;
  const shortEdges = [480, 720, 1080, 2160] as const;

  it.each(ratios)("pins the short edge to the requested value for %s", (ratio) => {
    for (const shortEdge of shortEdges) {
      const { width, height } = resolveRenderOutputDimensions(ratio, shortEdge);
      expect(Math.min(width, height)).toBe(shortEdge);
    }
  });

  it.each(ratios)("returns even dimensions on both axes for %s", (ratio) => {
    for (const shortEdge of shortEdges) {
      const { width, height } = resolveRenderOutputDimensions(ratio, shortEdge);
      expect(width % 2).toBe(0);
      expect(height % 2).toBe(0);
    }
  });

  it("resolves portrait at the true ratio rather than the logical canvas", () => {
    expect(resolveRenderOutputDimensions("9:16", 1080)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(resolveRenderOutputDimensions("3:4", 1080)).toEqual({
      width: 1080,
      height: 1440,
    });
  });

  it("matches the logical canvas for landscape and square at 1080", () => {
    expect(resolveRenderOutputDimensions("16:9", 1080)).toEqual(
      getProjectDimensions("16:9"),
    );
    expect(resolveRenderOutputDimensions("4:3", 1080)).toEqual(
      getProjectDimensions("4:3"),
    );
    expect(resolveRenderOutputDimensions("1:1", 1080)).toEqual(
      getProjectDimensions("1:1"),
    );
  });

  it("defaults to a 1080 short edge", () => {
    expect(resolveRenderOutputDimensions("9:16")).toEqual(
      resolveRenderOutputDimensions("9:16", 1080),
    );
  });

  it("falls back to 16:9 at 1080 for an unknown ratio", () => {
    // @ts-expect-error Testing invalid input
    expect(resolveRenderOutputDimensions("invalid", 720)).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});
