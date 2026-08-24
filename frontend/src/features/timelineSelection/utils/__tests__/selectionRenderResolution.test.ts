import { describe, expect, it } from "vitest";
import {
  resolveRegionRenderDimensions,
  resolveRegionRenderResolution,
  resolveSelectionRenderDimensions,
  resolveSelectionRenderResolution,
} from "../selectionRenderResolution";

describe("resolveSelectionRenderResolution", () => {
  it("prefers the selection's own choice over everything else", () => {
    expect(
      resolveSelectionRenderResolution({
        override: 480,
        recommended: 720,
        project: 1080,
      }),
    ).toBe(480);
  });

  it("falls back to the workflow's recommendation", () => {
    expect(
      resolveSelectionRenderResolution({
        override: null,
        recommended: 720,
        project: 1080,
      }),
    ).toBe(720);
  });

  it("falls back to the project when nothing else applies", () => {
    expect(
      resolveSelectionRenderResolution({ override: null, project: 2160 }),
    ).toBe(2160);
  });

  it("defaults to 1080 with no sources at all", () => {
    expect(resolveSelectionRenderResolution({})).toBe(1080);
  });

  // The override is picked from a fixed list; anything else would be accepted
  // here and then rejected by the project config it falls back to.
  it.each([1234, 0, -720, Number.NaN])(
    "ignores an unsupported override: %s",
    (override) => {
      expect(
        resolveSelectionRenderResolution({ override, project: 1080 }),
      ).toBe(1080);
    },
  );

  // A workflow's declared target is whatever its rules say. Rounding it to a
  // rung would defeat rendering at the size the workflow will actually use.
  it("accepts a non-rung recommendation from a workflow", () => {
    expect(
      resolveSelectionRenderResolution({ recommended: 832, project: 1080 }),
    ).toBe(832);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores an unusable recommendation: %s",
    (recommended) => {
      expect(
        resolveSelectionRenderResolution({ recommended, project: 720 }),
      ).toBe(720);
    },
  );
});

describe("resolveSelectionRenderDimensions", () => {
  it("resolves through the shared short-edge resolver", () => {
    expect(
      resolveSelectionRenderDimensions("9:16", { override: 720 }),
    ).toEqual({ width: 720, height: 1280 });
    expect(
      resolveSelectionRenderDimensions("16:9", { override: 720 }),
    ).toEqual({ width: 1280, height: 720 });
  });

  it("agrees with a project export of the same ratio and resolution", () => {
    // Both go through resolveRenderOutputDimensions; this pins that they do.
    expect(
      resolveSelectionRenderDimensions("3:4", { project: 1080 }),
    ).toEqual({ width: 1080, height: 1440 });
  });

  it("keeps a non-rung recommendation even in portrait", () => {
    expect(
      resolveSelectionRenderDimensions("9:16", { recommended: 832 }),
    ).toEqual({ width: 832, height: 1480 });
  });
});

/**
 * The region form is the consumer side: the value on a region was already
 * resolved when the region was created, so it is not re-validated against the
 * ladder — only an absent one falls back.
 */
describe("resolveRegionRenderResolution", () => {
  it("takes what the region carries", () => {
    expect(resolveRegionRenderResolution({ resolution: 480 }, 1080)).toBe(480);
  });

  it("keeps a non-rung value the region resolved to", () => {
    expect(resolveRegionRenderResolution({ resolution: 832 }, 1080)).toBe(832);
  });

  it.each([undefined, null, 0, -1, Number.NaN])(
    "falls back to the project for %s",
    (resolution) => {
      expect(resolveRegionRenderResolution({ resolution }, 720)).toBe(720);
    },
  );

  it("falls back to the default when the project value is unusable too", () => {
    expect(resolveRegionRenderResolution(null, 1234)).toBe(1080);
  });

  it("resolves dimensions through the shared resolver", () => {
    expect(
      resolveRegionRenderDimensions("9:16", { resolution: 480 }, 1080),
    ).toEqual({ width: 480, height: 854 });
  });
});
