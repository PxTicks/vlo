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

  it("rejects speed", () => {
    expect(isTransformCompatible(defByType("speed"), "adjustment")).toBe(false);
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

  it("audio clips still see volume and reject visual definitions", () => {
    expect(isTransformCompatible(defByType("volume"), "audio")).toBe(true);
    expect(isTransformCompatible(defByType("layout"), "audio")).toBe(false);
    expect(isTransformCompatible(defByType("fitMode"), "audio")).toBe(false);
  });

  it("mask editing (clipType=\"shape\") still sees mask-only transforms", () => {
    expect(isTransformCompatible(defByType("feather"), "shape")).toBe(true);
    expect(isTransformCompatible(defByType("mask_grow"), "shape")).toBe(true);
  });
});

describe("default + addable menus for adjustment clips", () => {
  it("layout is in the default set; fitMode is not", () => {
    const defaults = getDefaultTransforms().filter((def) =>
      isTransformCompatible(def, "adjustment"),
    );
    expect(defaults.map((d) => d.type)).toContain("layout");
    expect(defaults.map((d) => d.type)).not.toContain("fitMode");
    expect(defaults.map((d) => d.type)).not.toContain("volume");
  });

  it("the addable menu contains filters but not speed", () => {
    const addable = getAddableTransforms({ clipType: "adjustment" });
    // Speed is excluded for adjustment clips.
    expect(addable.find((d) => d.type === "speed")).toBeUndefined();
    // At least one filter is present.
    expect(addable.find((d) => d.type === "filter")).toBeDefined();
  });

  it("keeps hidden filters out of the adjustment add menu", () => {
    const adjustmentAddable = getAddableTransforms({ clipType: "adjustment" });
    expect(
      adjustmentAddable.find(
        (d) => d.type === "filter" && d.filterName === "AlphaFilter",
      ),
    ).toBeUndefined();
    expect(
      adjustmentAddable.find(
        (d) => d.type === "filter" && d.filterName === "ColorMatrixFilter",
      ),
    ).toBeUndefined();
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
