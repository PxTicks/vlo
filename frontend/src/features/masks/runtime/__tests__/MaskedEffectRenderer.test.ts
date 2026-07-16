import { describe, it, expect, vi } from "vitest";
import { Texture, type Renderer } from "pixi.js";
import { MaskedEffectRenderer } from "../MaskedEffectRenderer";
import type { FilterRenderStep } from "../../../transformations/effectMaskRenderPlan";
import type {
  ClipTransform,
  MaskBooleanExpression,
} from "../../../../types/TimelineTypes";

/**
 * Assembly: drive runMaskedEffectChain over real offscreen-filter + compositor
 * mechanisms and the ping-pong pool, with a mock renderer (records every GPU
 * pass) and fake resolveFilterOp/resolveCoverage. Asserts wiring, render-pass
 * counts, threading, and that no pass writes into the texture it reads.
 */

const EXPR: MaskBooleanExpression = { kind: "mask_ref", maskId: "m1" };
const CONTENT = { width: 64, height: 48 };

function step(
  id: string,
  resolution: FilterRenderStep["resolution"],
): FilterRenderStep {
  return {
    transform: {
      id,
      type: "filter",
      isEnabled: true,
      parameters: {},
    } as ClipTransform,
    resolution,
  };
}

interface Pass {
  container: { destroyed: boolean };
  input: Texture | undefined;
  target: unknown;
}

function setup(options: { coverage?: Texture | null } = {}) {
  const passes: Pass[] = [];
  const render = vi.fn(
    (opts: {
      container: { destroyed: boolean; texture?: Texture };
      target: unknown;
    }) => {
      passes.push({
        container: opts.container,
        input: opts.container.texture,
        target: opts.target,
      });
    },
  );
  const renderer = { render } as unknown as Renderer;
  const maskedRenderer = new MaskedEffectRenderer(renderer);

  const resolveFilterOp = vi.fn((t: ClipTransform) => ({
    type: "AlphaFilter",
    params: { alpha: 1, _id: t.id },
    sourceTransformId: t.id,
  }));
  const resolveCoverage = vi.fn(() =>
    options.coverage === undefined ? (Texture.WHITE as Texture) : options.coverage,
  );

  return { passes, render, maskedRenderer, resolveFilterOp, resolveCoverage };
}

describe("MaskedEffectRenderer", () => {
  it("returns the input unchanged for an empty step list (no GPU work)", () => {
    const { maskedRenderer, render, resolveFilterOp } = setup();
    const out = maskedRenderer.render({
      input: Texture.WHITE,
      steps: [],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage: () => null,
    });
    expect(out).toBe(Texture.WHITE);
    expect(render).not.toHaveBeenCalled();
    maskedRenderer.dispose();
  });

  it("releases retained filters when a later plan is empty", () => {
    const { maskedRenderer, passes, resolveFilterOp, resolveCoverage } = setup();
    maskedRenderer.render({
      input: Texture.WHITE,
      steps: [step("blur", { kind: "unmasked" })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    });
    const retainedSprite = passes[0].container;
    expect(retainedSprite.destroyed).toBe(false);

    maskedRenderer.render({
      input: Texture.WHITE,
      steps: [],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    });
    expect(retainedSprite.destroyed).toBe(true);
    maskedRenderer.dispose();
  });

  it("releases every retained filter after a partial chain failure", () => {
    const { maskedRenderer, passes, render, resolveFilterOp, resolveCoverage } =
      setup();
    render.mockImplementationOnce((opts) => {
      passes.push({
        container: opts.container,
        input: opts.container.texture,
        target: opts.target,
      });
    });
    render.mockImplementationOnce(() => {
      throw new Error("render boom");
    });

    expect(() =>
      maskedRenderer.render({
        input: Texture.WHITE,
        steps: [
          step("blur", { kind: "unmasked" }),
          step("sharpen", { kind: "unmasked" }),
        ],
        contentSize: CONTENT,
        resolveFilterOp,
        resolveCoverage,
      }),
    ).toThrow("render boom");
    expect(passes[0].container.destroyed).toBe(true);
    maskedRenderer.dispose();
  });

  it("applies an unmasked filter in one pass into a fresh target", () => {
    const { maskedRenderer, passes, render, resolveFilterOp, resolveCoverage } =
      setup();
    const out = maskedRenderer.render({
      input: Texture.WHITE,
      steps: [step("blur", { kind: "unmasked" })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    });

    expect(render).toHaveBeenCalledTimes(1);
    expect(resolveFilterOp).toHaveBeenCalledTimes(1);
    expect(resolveCoverage).not.toHaveBeenCalled();
    expect(passes[0].input).toBe(Texture.WHITE);
    expect(passes[0].target).not.toBe(Texture.WHITE);
    expect(out).toBe(passes[0].target);
    maskedRenderer.dispose();
  });

  it("masked step: filter pass + composite pass, coverage consulted", () => {
    const { maskedRenderer, passes, render, resolveFilterOp, resolveCoverage } =
      setup();
    const out = maskedRenderer.render({
      input: Texture.WHITE,
      steps: [step("colour", { kind: "masked", expression: EXPR })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    });

    // applyFilter (filter pass) + composite (single mix pass).
    expect(render).toHaveBeenCalledTimes(2);
    expect(resolveCoverage).toHaveBeenCalledWith(EXPR);
    // Final output is the composite target (the last pass).
    expect(out).toBe(passes[1].target);
    maskedRenderer.dispose();
  });

  it("masked step without coverage contributes nothing (no passes)", () => {
    const { maskedRenderer, render, resolveFilterOp, resolveCoverage } = setup({
      coverage: null,
    });
    const out = maskedRenderer.render({
      input: Texture.WHITE,
      steps: [step("colour", { kind: "masked", expression: EXPR })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    });

    expect(resolveCoverage).toHaveBeenCalledWith(EXPR);
    expect(render).not.toHaveBeenCalled();
    expect(out).toBe(Texture.WHITE);
    maskedRenderer.dispose();
  });

  it("passes through an unmasked step whose filter op is unresolved (no op)", () => {
    const { maskedRenderer, render, resolveCoverage } = setup();
    const out = maskedRenderer.render({
      input: Texture.WHITE,
      steps: [step("unknown", { kind: "unmasked" })],
      contentSize: CONTENT,
      resolveFilterOp: () => undefined, // unresolved filter
      resolveCoverage,
    });
    expect(render).not.toHaveBeenCalled();
    expect(out).toBe(Texture.WHITE);
    maskedRenderer.dispose();
  });

  it("reuses the cached output for an identical cacheKey (no new GPU passes)", () => {
    const { maskedRenderer, render, resolveFilterOp, resolveCoverage } = setup();
    const opts = {
      input: Texture.WHITE,
      steps: [step("blur", { kind: "unmasked" as const })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
      cacheKey: "k1",
    };
    const first = maskedRenderer.render(opts);
    expect(render).toHaveBeenCalledTimes(1);

    const second = maskedRenderer.render(opts);
    // Cache hit: same output, and no additional render pass ran.
    expect(second).toBe(first);
    expect(render).toHaveBeenCalledTimes(1);
    maskedRenderer.dispose();
  });

  it("does not resolve mask coverage again on a cache hit", () => {
    const { maskedRenderer, resolveFilterOp, resolveCoverage } = setup();
    const opts = {
      input: Texture.WHITE,
      steps: [step("blur", { kind: "masked" as const, expression: EXPR })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
      cacheKey: "masked-k1",
    };

    maskedRenderer.render(opts);
    expect(resolveCoverage).toHaveBeenCalledOnce();
    maskedRenderer.render(opts);
    expect(resolveCoverage).toHaveBeenCalledOnce();
    maskedRenderer.dispose();
  });

  it("re-renders when the cacheKey changes", () => {
    const { maskedRenderer, render, resolveFilterOp, resolveCoverage } = setup();
    const base = {
      input: Texture.WHITE,
      steps: [step("blur", { kind: "unmasked" as const })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    };
    maskedRenderer.render({ ...base, cacheKey: "k1" });
    maskedRenderer.render({ ...base, cacheKey: "k2" });
    expect(render).toHaveBeenCalledTimes(2);
    maskedRenderer.dispose();
  });

  it("never caches when no cacheKey is supplied", () => {
    const { maskedRenderer, render, resolveFilterOp, resolveCoverage } = setup();
    const base = {
      input: Texture.WHITE,
      steps: [step("blur", { kind: "unmasked" as const })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    };
    maskedRenderer.render(base);
    maskedRenderer.render(base);
    expect(render).toHaveBeenCalledTimes(2);
    maskedRenderer.dispose();
  });

  it("drops the cache when the cached output texture is destroyed", () => {
    const { maskedRenderer, render, resolveFilterOp, resolveCoverage } = setup();
    const opts = {
      input: Texture.WHITE,
      steps: [step("blur", { kind: "unmasked" as const })],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
      cacheKey: "k1",
    };
    const first = maskedRenderer.render(opts);
    first.destroy();
    maskedRenderer.render(opts);
    // The cached texture was destroyed, so the second call must re-render.
    expect(render).toHaveBeenCalledTimes(2);
    maskedRenderer.dispose();
  });

  it("threads a mixed chain without ever writing into a texture it reads", () => {
    const { maskedRenderer, passes, render, resolveFilterOp, resolveCoverage } =
      setup();
    const out = maskedRenderer.render({
      input: Texture.WHITE,
      steps: [
        step("blur", { kind: "unmasked" }),
        step("colour", { kind: "masked", expression: EXPR }),
        step("noop", { kind: "empty" }),
        step("sharpen", { kind: "unmasked" }),
      ],
      contentSize: CONTENT,
      resolveFilterOp,
      resolveCoverage,
    });

    // unmasked(1) + masked(2) + empty(0) + unmasked(1) = 4 passes.
    expect(render).toHaveBeenCalledTimes(4);
    // No pass aliases its own read with its write target.
    for (const pass of passes) {
      expect(pass.target).not.toBe(pass.input);
    }
    // The result is the final pass's target.
    expect(out).toBe(passes[passes.length - 1].target);
    maskedRenderer.dispose();
  });
});
