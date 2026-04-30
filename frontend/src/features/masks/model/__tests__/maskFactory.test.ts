import { describe, expect, it } from "vitest";
import {
  createMask,
  createMaskLayoutTransforms,
  getMaskLayoutState,
  isMaskActiveAtSourceTime,
  isPointInsideMask,
  normalizeMaskActiveRange,
  setMaskLayoutState,
} from "../maskFactory";

describe("maskFactory", () => {
  it("creates masks with mode/isEnabled invariants", () => {
    const enabled = createMask("rectangle", { mode: "apply" });
    expect(enabled.mode).toBe("apply");
    expect(enabled.isEnabled).toBe(true);

    const preview = createMask("circle", { mode: "preview" });
    expect(preview.mode).toBe("preview");
    expect(preview.isEnabled).toBe(true);
  });

  it("creates default layout transforms from parameters", () => {
    const mask = createMask("rectangle", {
      id: "mask_layout_defaults",
      parameters: {
        x: 12,
        y: -9,
        scaleX: 1.5,
        scaleY: 0.75,
        rotation: Math.PI / 4,
        baseWidth: 100,
        baseHeight: 80,
      },
    });

    expect(mask.transformations).toEqual(
      createMaskLayoutTransforms("mask_layout_defaults", {
        x: 12,
        y: -9,
        scaleX: 1.5,
        scaleY: 0.75,
        rotation: Math.PI / 4,
      }),
    );
  });

  it("reads and writes layout through transform stack helpers", () => {
    const mask = createMask("rectangle", { id: "mask_edit" });
    const nextTransforms = setMaskLayoutState(mask, {
      x: 25,
      y: -8,
      scaleX: 1.2,
      scaleY: 0.7,
      rotation: 0.5,
    });

    const resolved = getMaskLayoutState({
      ...mask,
      transformations: nextTransforms,
    });

    expect(resolved).toEqual({
      x: 25,
      y: -8,
      scaleX: 1.2,
      scaleY: 0.7,
      rotation: 0.5,
    });
  });

  it("supports hit testing for both legacy masks and mask clip shape sources", () => {
    const legacyMask = createMask("rectangle", {
      id: "mask_legacy_hit",
      parameters: {
        x: 40,
        y: 50,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        baseWidth: 100,
        baseHeight: 100,
      },
    });
    expect(isPointInsideMask({ x: 40, y: 50 }, legacyMask)).toBe(true);
    expect(isPointInsideMask({ x: -40, y: -50 }, legacyMask)).toBe(false);

    const maskClipShape = {
      id: "clip_parent::mask::m1",
      maskType: "circle" as const,
      maskParameters: { baseWidth: 80, baseHeight: 80 },
      transformations: createMaskLayoutTransforms("clip_parent::mask::m1", {
        x: 10,
        y: 10,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
      }),
    };
    expect(isPointInsideMask({ x: 10, y: 10 }, maskClipShape)).toBe(true);
  });

  it("treats masks without activeRange as always active", () => {
    expect(isMaskActiveAtSourceTime(undefined, 0)).toBe(true);
    expect(isMaskActiveAtSourceTime(undefined, 999_999)).toBe(true);
  });

  it("respects activeRange bounds inclusively", () => {
    const range = { startSourceTicks: 100, endSourceTicks: 200 };
    expect(isMaskActiveAtSourceTime(range, 99)).toBe(false);
    expect(isMaskActiveAtSourceTime(range, 100)).toBe(true);
    expect(isMaskActiveAtSourceTime(range, 150)).toBe(true);
    expect(isMaskActiveAtSourceTime(range, 200)).toBe(true);
    expect(isMaskActiveAtSourceTime(range, 201)).toBe(false);
  });

  it("normalizes inverted activeRange inputs and rejects malformed values", () => {
    expect(
      normalizeMaskActiveRange({ startSourceTicks: 500, endSourceTicks: 100 }),
    ).toEqual({ startSourceTicks: 100, endSourceTicks: 500 });
    expect(normalizeMaskActiveRange(null)).toBeUndefined();
    expect(
      normalizeMaskActiveRange({ startSourceTicks: "0", endSourceTicks: 1 }),
    ).toBeUndefined();
  });

  it("propagates activeRange through createMask", () => {
    const mask = createMask("rectangle", {
      activeRange: { startSourceTicks: 250, endSourceTicks: 50 },
    });
    expect(mask.activeRange).toEqual({
      startSourceTicks: 50,
      endSourceTicks: 250,
    });
    expect(createMask("rectangle").activeRange).toBeUndefined();
  });
});
