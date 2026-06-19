import { describe, it, expect, vi } from "vitest";
import { RenderTexture, Texture, type Renderer } from "pixi.js";
import { MaskedEffectCompositor } from "../MaskedEffectCompositor";
import { MaskedEffectMixFilter } from "../../../transformations/catalogue/mask/maskedEffectMixFilter";

/**
 * Composite via a single mix-filter pass: render the input sprite carrying a
 * MaskedEffectMixFilter (effect + coverage bound) into the target. Mock renderer
 * + real RenderTexture. The render call + filter wiring are asserted here; the
 * shader's pixel result needs a real renderer (see class note).
 */

function mockRenderer(): {
  renderer: Renderer;
  render: ReturnType<typeof vi.fn>;
} {
  const render = vi.fn();
  return { renderer: { render } as unknown as Renderer, render };
}

const CONTENT = { width: 32, height: 32 };

describe("MaskedEffectCompositor", () => {
  it("renders the input sprite through the mix filter with effect + coverage bound", () => {
    const setEffect = vi.spyOn(
      MaskedEffectMixFilter.prototype,
      "setEffectTexture",
    );
    const setCoverage = vi.spyOn(
      MaskedEffectMixFilter.prototype,
      "setCoverageTexture",
    );

    const { renderer, render } = mockRenderer();
    const compositor = new MaskedEffectCompositor(renderer);
    const target = RenderTexture.create(CONTENT);
    const effect = RenderTexture.create(CONTENT);
    const coverage = RenderTexture.create(CONTENT);

    let filtersAtRender: readonly unknown[] | null | undefined;
    let textureAtRender: Texture | undefined;
    let targetAtRender: unknown;
    let clearAtRender: unknown;
    render.mockImplementation((opts) => {
      filtersAtRender = opts.container.filters;
      textureAtRender = opts.container.texture;
      targetAtRender = opts.target;
      clearAtRender = opts.clear;
    });

    compositor.composite(Texture.WHITE, effect, coverage, target);

    expect(render).toHaveBeenCalledTimes(1);
    expect(targetAtRender).toBe(target);
    expect(clearAtRender).toBe(true);
    expect(textureAtRender).toBe(Texture.WHITE);
    expect(filtersAtRender).toHaveLength(1);
    expect(filtersAtRender?.[0]).toBeInstanceOf(MaskedEffectMixFilter);
    expect(setEffect).toHaveBeenCalledWith(effect);
    expect(setCoverage).toHaveBeenCalledWith(coverage);

    target.destroy(true);
    effect.destroy(true);
    coverage.destroy(true);
    compositor.dispose();
    setEffect.mockRestore();
    setCoverage.mockRestore();
  });

  it("clears the sprite's filters after rendering, even on throw", () => {
    const { renderer } = mockRenderer();
    const compositor = new MaskedEffectCompositor(renderer);
    const target = RenderTexture.create(CONTENT);
    const effect = RenderTexture.create(CONTENT);
    const coverage = RenderTexture.create(CONTENT);

    let spriteRef: { filters?: readonly unknown[] | null } | undefined;
    (renderer.render as ReturnType<typeof vi.fn>).mockImplementation((opts) => {
      spriteRef = opts.container;
      throw new Error("render boom");
    });

    expect(() =>
      compositor.composite(Texture.WHITE, effect, coverage, target),
    ).toThrow("render boom");
    expect(spriteRef?.filters).toBeNull();

    target.destroy(true);
    effect.destroy(true);
    coverage.destroy(true);
    compositor.dispose();
  });

  it("reuses one sprite + filter across composites", () => {
    const { renderer, render } = mockRenderer();
    const compositor = new MaskedEffectCompositor(renderer);
    const target = RenderTexture.create(CONTENT);
    const effect = RenderTexture.create(CONTENT);
    const coverage = RenderTexture.create(CONTENT);

    const containers: unknown[] = [];
    const filters: unknown[] = [];
    render.mockImplementation((opts) => {
      containers.push(opts.container);
      filters.push(opts.container.filters?.[0]);
    });

    compositor.composite(Texture.WHITE, effect, coverage, target);
    compositor.composite(Texture.EMPTY, effect, coverage, target);

    expect(containers[0]).toBe(containers[1]);
    expect(filters[0]).toBe(filters[1]);
    expect(filters[0]).toBeInstanceOf(MaskedEffectMixFilter);

    target.destroy(true);
    effect.destroy(true);
    coverage.destroy(true);
    compositor.dispose();
  });
});
