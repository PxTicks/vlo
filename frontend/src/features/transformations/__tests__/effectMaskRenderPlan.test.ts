import { describe, it, expect } from "vitest";
import {
  planTransformRender,
  resolveEffectMask,
  type EffectMaskResolution,
} from "../effectMaskRenderPlan";
import type {
  ClipTransform,
  EffectMask,
  MaskBooleanExpression,
} from "../../../types/TimelineTypes";

/**
 * Phase 5 kernel: the effect-mask truth table + the legacy-vs-offscreen render
 * decision. Pure — no renderer. The GPU MaskedEffectRenderer consumes the steps
 * later.
 */

const EXPR: MaskBooleanExpression = { kind: "mask_ref", maskId: "m1" };

function filter(
  id: string,
  options: { enabled?: boolean; effectMask?: EffectMask } = {},
): ClipTransform {
  return {
    id,
    type: "filter",
    isEnabled: options.enabled ?? true,
    parameters: {},
    ...(options.effectMask ? { effectMask: options.effectMask } : {}),
  };
}

function nonFilter(type: string, effectMask?: EffectMask): ClipTransform {
  return {
    id: type,
    type,
    isEnabled: true,
    parameters: {},
    ...(effectMask ? { effectMask } : {}),
  };
}

describe("resolveEffectMask", () => {
  it("is unmasked when the field is absent", () => {
    expect(resolveEffectMask(filter("f"))).toEqual({ kind: "unmasked" });
  });

  it("is unmasked when disabled, regardless of expression", () => {
    const t = filter("f", {
      effectMask: { enabled: false, expression: EXPR, mode: "composite" },
    });
    expect(resolveEffectMask(t)).toEqual({ kind: "unmasked" });
  });

  it("is empty when enabled with no expression (never whole-clip)", () => {
    const t = filter("f", {
      effectMask: { enabled: true, expression: null, mode: "composite" },
    });
    expect(resolveEffectMask(t)).toEqual({ kind: "empty" });
  });

  it("is masked when enabled with an expression", () => {
    const t = filter("f", {
      effectMask: { enabled: true, expression: EXPR, mode: "composite" },
    });
    expect(resolveEffectMask(t)).toEqual({
      kind: "masked",
      expression: EXPR,
    } satisfies EffectMaskResolution);
  });
});

describe("planTransformRender", () => {
  it("is legacy for no transforms", () => {
    expect(planTransformRender(undefined)).toEqual({ mode: "legacy" });
    expect(planTransformRender([])).toEqual({ mode: "legacy" });
  });

  it("is legacy when no filter carries an active effect mask", () => {
    const plan = planTransformRender([
      nonFilter("layout"),
      filter("blur"),
      filter("colour", {
        effectMask: { enabled: false, expression: EXPR, mode: "composite" },
      }),
    ]);
    expect(plan).toEqual({ mode: "legacy" });
  });

  it("routes through offscreen when any filter has an active mask, including empty", () => {
    const empty = filter("blur", {
      effectMask: { enabled: true, expression: null, mode: "composite" },
    });
    const plan = planTransformRender([empty]);
    expect(plan.mode).toBe("offscreen");
    if (plan.mode !== "offscreen") return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].resolution).toEqual({ kind: "empty" });
  });

  it("includes every enabled filter in transform order with its resolution", () => {
    const blur = filter("blur"); // unmasked
    const colour = filter("colour", {
      effectMask: { enabled: true, expression: EXPR, mode: "composite" },
    });
    const sharpen = filter("sharpen"); // unmasked, after the masked one

    const plan = planTransformRender([
      nonFilter("layout"),
      blur,
      nonFilter("speed"),
      colour,
      sharpen,
    ]);

    expect(plan.mode).toBe("offscreen");
    if (plan.mode !== "offscreen") return;
    // Order preserved, non-filter transforms excluded.
    expect(plan.steps.map((s) => s.transform)).toEqual([blur, colour, sharpen]);
    expect(plan.steps.map((s) => s.resolution.kind)).toEqual([
      "unmasked",
      "masked",
      "unmasked",
    ]);
  });

  it("excludes disabled filters even when they carry an effect mask", () => {
    const disabledMasked = filter("blur", {
      enabled: false,
      effectMask: { enabled: true, expression: EXPR, mode: "composite" },
    });
    // A disabled filter does not apply at all, so it neither contributes a step
    // nor forces offscreen routing.
    expect(planTransformRender([disabledMasked])).toEqual({ mode: "legacy" });
  });

  it("ignores effect masks on non-filter transforms (v1 scope)", () => {
    // An effect mask on a layout transform must not trigger offscreen routing.
    const plan = planTransformRender([
      nonFilter("layout", { enabled: true, expression: EXPR, mode: "composite" }),
      filter("blur"),
    ]);
    expect(plan).toEqual({ mode: "legacy" });
  });
});
