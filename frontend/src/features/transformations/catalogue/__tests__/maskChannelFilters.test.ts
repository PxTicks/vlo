import { beforeEach, describe, expect, it, vi } from "vitest";

const { filterFromSpy } = vi.hoisted(() => ({
  filterFromSpy: vi.fn(),
}));

vi.mock("pixi.js", () => ({
  Filter: {
    from: filterFromSpy,
  },
}));

import {
  createMaskBinaryThresholdFilter,
  createMaskPreviewOverlayFilter,
} from "../mask/maskBinaryThresholdFilter";
import { createMaskCoverageBoostFilter } from "../mask/maskCoverageBoostFilter";
import { createMaskCoverageInvertFilter } from "../mask/maskCoverageInvertFilter";
import { createMaskRedToAlphaFilter } from "../mask/maskRedToAlphaFilter";

describe("mask channel filters", () => {
  beforeEach(() => {
    filterFromSpy.mockReset();
    filterFromSpy.mockReturnValue({});
  });

  it("thresholds composite mask coverage from the red channel only", () => {
    createMaskBinaryThresholdFilter();

    const fragment = filterFromSpy.mock.calls[0]?.[0]?.gl?.fragment as
      | string
      | undefined;

    expect(fragment).toContain("float coverage = color.r;");
    expect(fragment).not.toContain("color.a");
    expect(fragment).not.toContain("max(color.r, color.a)");
  });

  it("tints preview overlays after measuring RGB coverage", () => {
    createMaskPreviewOverlayFilter(0x60a5fa, 0.45);

    const fragment = filterFromSpy.mock.calls[0]?.[0]?.gl?.fragment as
      | string
      | undefined;

    expect(fragment).toContain("max(color.r, max(color.g, color.b))");
    expect(fragment).toContain("0.376471 * overlayAlpha");
    expect(fragment).toContain("0.450000");
  });

  it("presents the final composite mask from the red channel only", () => {
    createMaskRedToAlphaFilter();

    const fragment = filterFromSpy.mock.calls[0]?.[0]?.gl?.fragment as
      | string
      | undefined;

    expect(fragment).toContain("float coverage = color.r;");
    expect(fragment).not.toContain("max(color.r, color.a)");
  });

  it("boosts blurred coverage to preserve the old stronger feather shoulder", () => {
    createMaskCoverageBoostFilter();

    const fragment = filterFromSpy.mock.calls[0]?.[0]?.gl?.fragment as
      | string
      | undefined;

    expect(fragment).toContain("color.r * 3.0");
    expect(fragment).toContain("vec4(coverage, coverage, coverage, coverage)");
  });

  it("inverts red coverage while preserving alpha alignment", () => {
    createMaskCoverageInvertFilter();

    const fragment = filterFromSpy.mock.calls[0]?.[0]?.gl?.fragment as
      | string
      | undefined;

    expect(fragment).toContain("1.0 - color.r");
    expect(fragment).toContain("vec4(coverage, coverage, coverage, coverage)");
  });
});
