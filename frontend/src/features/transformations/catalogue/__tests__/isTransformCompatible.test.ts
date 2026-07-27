import { describe, expect, it } from "vitest";
import {
  TransformationRegistry,
  getAddableTransforms,
  getDefaultTransforms,
  isTransformCompatible,
} from "../TransformationRegistry";

function defByType(type: string) {
  const def = TransformationRegistry.find((entry) => entry.type === type);
  if (!def) throw new Error(`No definition for type "${type}"`);
  return def;
}

function defByFilterName(filterName: string) {
  const def = TransformationRegistry.find(
    (entry) => entry.type === "filter" && entry.filterName === filterName,
  );
  if (!def) throw new Error(`No filter definition for "${filterName}"`);
  return def;
}

describe("isTransformCompatible — adjustment clips", () => {
  it("accepts the layout definition (position/scale/rotation)", () => {
    expect(isTransformCompatible(defByType("layout"), "adjustment")).toBe(true);
  });

  it("rejects fitMode (now its own definition; not adjustmentCompatible)", () => {
    expect(isTransformCompatible(defByType("fitMode"), "adjustment")).toBe(false);
  });

  it("accepts speed", () => {
    expect(isTransformCompatible(defByType("speed"), "adjustment")).toBe(true);
  });

  it("rejects volume (audio-only)", () => {
    expect(isTransformCompatible(defByType("volume"), "adjustment")).toBe(false);
  });

  it("rejects mask-only transforms (feather, mask_grow)", () => {
    expect(isTransformCompatible(defByType("feather"), "adjustment")).toBe(false);
    expect(isTransformCompatible(defByType("mask_grow"), "adjustment")).toBe(
      false,
    );
  });

  it("accepts every registered filter on an adjustment clip", () => {
    const filters = TransformationRegistry.filter(
      (def) => def.type === "filter",
    );
    expect(filters.length).toBeGreaterThan(0);
    for (const def of filters) {
      expect(
        isTransformCompatible(def, "adjustment"),
      ).toBe(true);
    }
  });

  it("accepts a sample of spatial filters (blur, hsl, zoomBlur)", () => {
    expect(
      isTransformCompatible(defByFilterName("BlurFilter"), "adjustment"),
    ).toBe(true);
    expect(
      isTransformCompatible(
        defByFilterName("HslAdjustmentFilter"),
        "adjustment",
      ),
    ).toBe(true);
    expect(
      isTransformCompatible(defByFilterName("ZoomBlurFilter"), "adjustment"),
    ).toBe(true);
  });
});

describe("isTransformCompatible — non-adjustment paths unchanged after the fitMode split", () => {
  it("video clips still see fitMode + layout as defaults", () => {
    expect(isTransformCompatible(defByType("layout"), "video")).toBe(true);
    expect(isTransformCompatible(defByType("fitMode"), "video")).toBe(true);
  });

  it("audio clips see volume and speed but reject visual definitions", () => {
    expect(isTransformCompatible(defByType("volume"), "audio")).toBe(true);
    expect(isTransformCompatible(defByType("speed"), "audio")).toBe(true);
    expect(isTransformCompatible(defByType("layout"), "audio")).toBe(false);
    expect(isTransformCompatible(defByType("fitMode"), "audio")).toBe(false);
  });

  it("mask editing (clipType=\"shape\") still sees mask-only transforms", () => {
    expect(isTransformCompatible(defByType("feather"), "shape")).toBe(true);
    expect(isTransformCompatible(defByType("mask_grow"), "shape")).toBe(true);
  });
});

describe("default + addable menus for adjustment clips", () => {
  it("layout and speed are in the default set; fitMode is not", () => {
    const defaults = getDefaultTransforms().filter((def) =>
      isTransformCompatible(def, "adjustment"),
    );
    expect(defaults.map((d) => d.type)).toContain("layout");
    expect(defaults.map((d) => d.type)).toContain("speed");
    expect(defaults.map((d) => d.type)).not.toContain("fitMode");
    expect(defaults.map((d) => d.type)).not.toContain("volume");
  });

  it("the addable menu contains filters but not speed", () => {
    const addable = getAddableTransforms({ clipType: "adjustment" });
    expect(addable.find((d) => d.type === "speed")).toBeUndefined();
    // At least one filter is present.
    expect(addable.find((d) => d.type === "filter")).toBeDefined();
  });

  it("keeps internal and legacy color filters out of add menus", () => {
    const adjustmentAddable = getAddableTransforms({ clipType: "adjustment" });
    const adjustmentFilterNames = adjustmentAddable
      .filter((definition) => definition.type === "filter")
      .map((definition) => definition.filterName);

    expect(adjustmentFilterNames).not.toContain("AlphaFilter");
    expect(adjustmentFilterNames).not.toContain("ColorMatrix");
    expect(adjustmentFilterNames).not.toContain("HslAdjustmentFilter");
    expect(adjustmentFilterNames).not.toContain("AdjustmentFilter");

    const videoFilterNames = getAddableTransforms({ clipType: "video" })
      .filter((definition) => definition.type === "filter")
      .map((definition) => definition.filterName);
    expect(videoFilterNames).not.toContain("HslAdjustmentFilter");
    expect(videoFilterNames).not.toContain("AdjustmentFilter");
  });

  it("still treats hidden AlphaFilter as render-compatible for adjustment clips", () => {
    expect(
      isTransformCompatible(
        defByFilterName("AlphaFilter"),
        "adjustment",
      ),
    ).toBe(true);
    expect(
      getAddableTransforms({ clipType: "video" }).find(
        (d) => d.type === "filter" && d.filterName === "AlphaFilter",
      ),
    ).toBeUndefined();
  });
});
