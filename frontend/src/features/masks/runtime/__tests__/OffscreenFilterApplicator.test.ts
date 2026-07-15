import { describe, it, expect, vi } from "vitest";
import { AlphaFilter, RenderTexture, Texture, type Renderer } from "pixi.js";
import { OffscreenFilterApplicator } from "../OffscreenFilterApplicator";

/**
 * Offscreen single-filter application. Uses a mock renderer (records render
 * calls) + a real RenderTexture target, the same pattern the mask GPU pipeline
 * is tested with. Asserts it reuses the canonical filterApplicator (a real Pixi
 * filter is built and retained on the sprite) and renders to the target.
 */

function mockRenderer(): {
  renderer: Renderer;
  render: ReturnType<typeof vi.fn>;
} {
  const render = vi.fn();
  return { renderer: { render } as unknown as Renderer, render };
}

const CONTENT = { width: 64, height: 48 };

describe("OffscreenFilterApplicator", () => {
  it("renders the input through the resolved filter into the target", () => {
    const { renderer, render } = mockRenderer();
    const applicator = new OffscreenFilterApplicator(renderer);
    const target = RenderTexture.create(CONTENT);

    // Capture sprite state at render time.
    let filtersAtRender: readonly unknown[] | null | undefined;
    let textureAtRender: Texture | undefined;
    let targetAtRender: unknown;
    let clearAtRender: unknown;
    render.mockImplementation((opts: {
      container: { filters?: readonly unknown[] | null; texture?: Texture };
      target: unknown;
      clear: unknown;
    }) => {
      filtersAtRender = opts.container.filters;
      textureAtRender = opts.container.texture;
      targetAtRender = opts.target;
      clearAtRender = opts.clear;
    });

    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 0.5 } },
      target,
      CONTENT,
    );

    expect(render).toHaveBeenCalledTimes(1);
    expect(targetAtRender).toBe(target);
    expect(clearAtRender).toBe(true);
    expect(textureAtRender).toBe(Texture.WHITE);
    // A real Pixi filter was constructed for the op via filterApplicator.
    expect(filtersAtRender).toHaveLength(1);
    expect(filtersAtRender?.[0]).toBeInstanceOf(AlphaFilter);
    expect((filtersAtRender?.[0] as AlphaFilter).alpha).toBe(0.5);

    target.destroy(true);
    applicator.dispose();
  });

  it("retains the filter on its transform slot across passes (temporal reuse)", () => {
    const { renderer } = mockRenderer();
    const applicator = new OffscreenFilterApplicator(renderer);
    const target = RenderTexture.create(CONTENT);

    let spriteRef: { filters?: readonly unknown[] | null } | undefined;
    (renderer.render as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { container: { filters?: readonly unknown[] | null } }) => {
        spriteRef = opts.container;
      },
    );

    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 1 }, sourceTransformId: "t1" },
      target,
      CONTENT,
    );

    // The slot keeps its temporal filter instance for reuse on the next frame's
    // pass — it is not nulled after render.
    expect(spriteRef?.filters).toHaveLength(1);
    expect(spriteRef?.filters?.[0]).toBeInstanceOf(AlphaFilter);
    target.destroy(true);
    applicator.dispose();
  });

  it("keeps a separate slot per transform ID and prunes unused ones", () => {
    const { renderer, render } = mockRenderer();
    const applicator = new OffscreenFilterApplicator(renderer);
    const target = RenderTexture.create(CONTENT);

    const containers: unknown[] = [];
    render.mockImplementation((opts: { container: unknown }) => {
      containers.push(opts.container);
    });

    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 1 }, sourceTransformId: "t1" },
      target,
      CONTENT,
    );
    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 0.5 }, sourceTransformId: "t2" },
      target,
      CONTENT,
    );

    // Distinct authored transforms get distinct retained sprites, so their
    // (possibly temporal) filter instances never share a slot.
    expect(containers[0]).not.toBe(containers[1]);
    const spriteForT1 = containers[0] as { destroyed: boolean };

    // A later plan that only uses t2 prunes t1's slot and destroys its sprite.
    applicator.retainOnly(new Set(["t2"]));
    expect(spriteForT1.destroyed).toBe(true);

    target.destroy(true);
    applicator.dispose();
  });

  it("destroys native filters when their retained slot is disposed", () => {
    const { renderer, render } = mockRenderer();
    const applicator = new OffscreenFilterApplicator(renderer);
    const target = RenderTexture.create(CONTENT);

    let filter: AlphaFilter | undefined;
    render.mockImplementation(
      (opts: { container: { filters?: readonly unknown[] | null } }) => {
        filter = opts.container.filters?.[0] as AlphaFilter | undefined;
      },
    );
    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 1 }, sourceTransformId: "t1" },
      target,
      CONTENT,
    );

    expect(filter).toBeDefined();
    const destroy = vi.spyOn(filter!, "destroy");
    applicator.dispose();
    expect(destroy).toHaveBeenCalledOnce();

    target.destroy(true);
  });

  it("drops a retained slot when rendering throws", () => {
    const { renderer, render } = mockRenderer();
    const applicator = new OffscreenFilterApplicator(renderer);
    const target = RenderTexture.create(CONTENT);
    let failedSprite: { destroyed: boolean } | undefined;

    render.mockImplementationOnce(
      (opts: { container: { destroyed: boolean } }) => {
        failedSprite = opts.container;
        throw new Error("render boom");
      },
    );

    expect(() =>
      applicator.applyFilterToTexture(
        Texture.WHITE,
        { type: "AlphaFilter", params: { alpha: 1 }, sourceTransformId: "t1" },
        target,
        CONTENT,
      ),
    ).toThrow("render boom");
    expect(failedSprite?.destroyed).toBe(true);

    let retrySprite: unknown;
    render.mockImplementationOnce((opts: { container: unknown }) => {
      retrySprite = opts.container;
    });
    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 1 }, sourceTransformId: "t1" },
      target,
      CONTENT,
    );
    expect(retrySprite).not.toBe(failedSprite);

    target.destroy(true);
    applicator.dispose();
  });

  it("reuses one sprite across passes and renders each to its own target", () => {
    const { renderer, render } = mockRenderer();
    const applicator = new OffscreenFilterApplicator(renderer);
    const targetA = RenderTexture.create(CONTENT);
    const targetB = RenderTexture.create(CONTENT);

    const containers: unknown[] = [];
    render.mockImplementation((opts: { container: unknown }) => {
      containers.push(opts.container);
    });

    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 1 } },
      targetA,
      CONTENT,
    );
    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "AlphaFilter", params: { alpha: 0.25 } },
      targetB,
      CONTENT,
    );

    expect(render).toHaveBeenCalledTimes(2);
    // Same reused sprite instance for both passes.
    expect(containers[0]).toBe(containers[1]);

    targetA.destroy(true);
    targetB.destroy(true);
    applicator.dispose();
  });

  it("ignores an unknown filter op (no filter constructed)", () => {
    const { renderer, render } = mockRenderer();
    const applicator = new OffscreenFilterApplicator(renderer);
    const target = RenderTexture.create(CONTENT);

    let filtersAtRender: readonly unknown[] | null | undefined;
    render.mockImplementation(
      (opts: { container: { filters?: readonly unknown[] | null } }) => {
        filtersAtRender = opts.container.filters;
      },
    );

    applicator.applyFilterToTexture(
      Texture.WHITE,
      { type: "NotARealFilter", params: {} },
      target,
      CONTENT,
    );

    // filterApplicator skips unknown ops -> empty filter list, still renders.
    expect(render).toHaveBeenCalledTimes(1);
    expect(filtersAtRender).toHaveLength(0);

    target.destroy(true);
    applicator.dispose();
  });
});
