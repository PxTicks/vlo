import { describe, it, expect, vi } from "vitest";
import type { Texture } from "pixi.js";
import {
  runMaskedEffectChain,
  type MaskedEffectGpuOps,
} from "../maskedEffectChain";
import type { FilterRenderStep } from "../effectMaskRenderPlan";
import type {
  ClipTransform,
  MaskBooleanExpression,
} from "../../../types/TimelineTypes";

/**
 * Phase 5 chain policy: thread an input texture through ordered filter steps,
 * with the safety rule that a masked step lacking coverage contributes nothing
 * (never whole-clip). Textures are opaque string tokens; GPU ops are fakes.
 */

const EXPR: MaskBooleanExpression = { kind: "mask_ref", maskId: "m1" };

function tex(id: string): Texture {
  return id as unknown as Texture;
}

function filterStep(
  id: string,
  resolution: FilterRenderStep["resolution"],
): FilterRenderStep {
  return {
    transform: { id, type: "filter", isEnabled: true, parameters: {} } as ClipTransform,
    resolution,
  };
}

/** Fake ops: applyFilter tags output as `${input}>${transformId}`; composite as
 *  `mix(${input},${effect},${coverage})`; coverage resolves unless suppressed. */
function buildOps(
  options: { noCoverage?: boolean } = {},
): MaskedEffectGpuOps & {
  applyFilter: ReturnType<typeof vi.fn>;
  composite: ReturnType<typeof vi.fn>;
  resolveCoverage: ReturnType<typeof vi.fn>;
} {
  const applyFilter = vi.fn((input: Texture, transform: ClipTransform) =>
    tex(`${String(input)}>${transform.id}`),
  );
  const resolveCoverage = vi.fn(() =>
    options.noCoverage ? null : tex("cov"),
  );
  const composite = vi.fn(
    (input: Texture, effect: Texture, coverage: Texture) =>
      tex(`mix(${String(input)},${String(effect)},${String(coverage)})`),
  );
  return { applyFilter, resolveCoverage, composite };
}

describe("runMaskedEffectChain", () => {
  it("applies an unmasked filter to the whole texture in place", () => {
    const ops = buildOps();
    const out = runMaskedEffectChain(
      tex("in"),
      [filterStep("blur", { kind: "unmasked" })],
      ops,
    );
    expect(String(out)).toBe("in>blur");
    expect(ops.composite).not.toHaveBeenCalled();
    expect(ops.resolveCoverage).not.toHaveBeenCalled();
  });

  it("composites a masked filter through coverage over the untouched input", () => {
    const ops = buildOps();
    const out = runMaskedEffectChain(
      tex("in"),
      [filterStep("blur", { kind: "masked", expression: EXPR })],
      ops,
    );
    // effect = in>blur ; out = mix(in, in>blur, cov)
    expect(ops.applyFilter).toHaveBeenCalledTimes(1);
    expect(ops.composite).toHaveBeenCalledWith(tex("in"), tex("in>blur"), tex("cov"));
    expect(String(out)).toBe("mix(in,in>blur,cov)");
  });

  it("skips an empty step, passing the running texture through unchanged", () => {
    const ops = buildOps();
    const out = runMaskedEffectChain(
      tex("in"),
      [filterStep("blur", { kind: "empty" })],
      ops,
    );
    expect(String(out)).toBe("in");
    expect(ops.applyFilter).not.toHaveBeenCalled();
  });

  it("contributes nothing for a masked step whose coverage is unavailable (no whole-clip fallback)", () => {
    const ops = buildOps({ noCoverage: true });
    const out = runMaskedEffectChain(
      tex("in"),
      [filterStep("blur", { kind: "masked", expression: EXPR })],
      ops,
    );
    expect(ops.resolveCoverage).toHaveBeenCalledTimes(1);
    // Crucially: the filter is NOT applied to the whole clip.
    expect(ops.applyFilter).not.toHaveBeenCalled();
    expect(ops.composite).not.toHaveBeenCalled();
    expect(String(out)).toBe("in");
  });

  it("threads outputs through a mixed chain in order", () => {
    const ops = buildOps();
    const out = runMaskedEffectChain(
      tex("in"),
      [
        filterStep("blur", { kind: "unmasked" }),
        filterStep("colour", { kind: "masked", expression: EXPR }),
        filterStep("noop", { kind: "empty" }),
        filterStep("sharpen", { kind: "unmasked" }),
      ],
      ops,
    );
    // in>blur ; mask: effect = in>blur>colour, current = mix(in>blur, in>blur>colour, cov)
    // empty skipped ; then sharpen applied to the masked result
    expect(String(out)).toBe(
      "mix(in>blur,in>blur>colour,cov)>sharpen",
    );
  });

  it("returns the input unchanged when every step is a no-op", () => {
    const ops = buildOps({ noCoverage: true });
    const out = runMaskedEffectChain(
      tex("in"),
      [
        filterStep("a", { kind: "empty" }),
        filterStep("b", { kind: "masked", expression: EXPR }),
      ],
      ops,
    );
    expect(out).toBe(tex("in"));
    expect(ops.applyFilter).not.toHaveBeenCalled();
  });

  it("returns the input unchanged for an empty step list", () => {
    const ops = buildOps();
    expect(runMaskedEffectChain(tex("in"), [], ops)).toBe(tex("in"));
  });
});
