import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TransformState, ClipTransformTarget } from "../types";
import type {
  BlurFilter,
  ContainerChild,
  Filter,
  ObservablePoint,
  Texture,
  TextureSource,
} from "pixi.js";

const { MockFilter } = vi.hoisted(() => {
  return {
    // Stands in for several filter classes; each subclass below is checked.
    MockFilter: class {
      blur: number = 0;
      matrix: number[] = [];
    },
  };
});

// Mock internal Pixi components used by the applicator
vi.mock("pixi.js", async () => {
  const { fake } = await import("../../../../testUtils/libraryFakes");
  const texture = (width: number, height: number) =>
    fake<Texture>({
      width,
      height,
      source: fake<TextureSource>({
        alphaMode: "premultiply-alpha-on-upload",
      }),
    });
  const MOCK_TEXTURE = texture(100, 100);
  const TEXTURE_EMPTY = texture(0, 0);
  const point = () => fake<ObservablePoint>({ copyFrom: vi.fn() });
  return {
    Filter: {
      from: () => new MockFilter(),
    },
    Texture: { EMPTY: TEXTURE_EMPTY },
    MaskFilter: class extends MockFilter {
      constructor(opts?: unknown) {
        void opts;
        super();
      }
    },
    BlurFilter: class extends MockFilter implements Partial<BlurFilter> {
      blur: number = 0;
      strength: number = 0;
    },
    ColorMatrixFilter: class extends MockFilter {
      matrix: number[] = [];
    },
    Container: class MockContainer implements Partial<Container> {
      children: ContainerChild[] = [];
      parent: Container | null = null;
      filters: readonly Filter[] = [];
      addChild<U extends ContainerChild[]>(...added: U): U[0] {
        for (const child of added) {
          this.children.push(child);
          child.parent = this as unknown as Container;
        }
        return added[0];
      }
      addChildAt<U extends ContainerChild>(child: U, index: number): U {
        this.children.splice(index, 0, child);
        child.parent = this as unknown as Container;
        return child;
      }
      getChildIndex(child: ContainerChild) {
        return this.children.indexOf(child);
      }
      removeChild<U extends ContainerChild[]>(...removed: U): U[0] {
        for (const child of removed) {
          const index = this.children.indexOf(child);
          if (index > -1) {
            this.children.splice(index, 1);
          }
          child.parent = null as unknown as Container;
        }
        return removed[0];
      }
    },
    Sprite: class MockSprite implements Partial<Sprite> {
      parent: Container | null = null;
      texture = MOCK_TEXTURE;
      mask: Container | null = null;
      filters: readonly Filter[] = [];
      renderable: boolean = true;
      alpha: number = 1;
      position = point();
      scale = point();
      rotation = 0;
      skew = point();
      anchor = point();
      pivot = point();
      destroy = vi.fn();
    },
  };
});

import { featherApplicator } from "../mask/featherApplicator";
import { Sprite, Container } from "pixi.js";

describe("featherApplicator", () => {
  let mockSprite: Sprite;
  let mockContainer: Container;

  const createBaseState = (): TransformState => ({
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    filters: [],
  });
  const createFeather = (
    mode: "hard_outer" | "soft_inner" | "two_way",
    amount: number,
  ) => ({ mode, amount, invert: false });
  const createGrow = (amount: number) => ({ amount, invert: false });

  beforeEach(() => {
    vi.clearAllMocks();
    mockContainer = new Container();
    mockSprite = new Sprite();
    // Simulate target being inside the track container
    mockContainer.addChild(mockSprite);
  });

  it("should do nothing if feather state is absent", () => {
    const state = createBaseState();
    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);
    expect(mockContainer.children).toHaveLength(1); // Only the original sprite
    expect(mockSprite.mask).toBeNull();
  });

  it("should clean up the rig if feather amount drops to 0", () => {
    // 1. Setup the rig
    const state = createBaseState();
    state.feather = createFeather("soft_inner", 10);
    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    // Soft inner adds a non-renderable self-mask companion.
    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).not.toBeNull();

    // 2. Tear it down
    state.feather!.amount = 0;
    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    expect(mockSprite.mask).toBeNull();
    // The rig sprites should have their destroy() method called
    // We cannot easily check internal rig state here outside of the destroy spies
    // but we can ensure the mask is detached.
  });

  it("should apply Soft feather correctly", () => {
    const state = createBaseState();
    state.feather = createFeather("soft_inner", 20);

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    // Soft inner blurs the sprite and constrains blur with a self-mask.
    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).not.toBeNull();
    expect(mockSprite.filters).toHaveLength(2); // Cleanup and Blur
    const mask = mockSprite.mask as Sprite;
    expect(mask.renderable).toBe(false);
    expect(mask.filters).toHaveLength(1); // Cleanup only, no blur
  });

  it("should apply Hard Outer feather correctly", () => {
    const state = createBaseState();
    state.feather = createFeather("hard_outer", 15);

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    // Outer attaches the bottomLayer to the container but drops the mask
    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).toBeNull();

    // The bottom layer should have Blur and Boost filters
    const bottomLayer = mockContainer.children.find((c) => c !== mockSprite);
    expect(bottomLayer).toBeDefined();
    expect(bottomLayer!.filters).toHaveLength(3); // Cleanup, Blur, and Boost
  });

  it("keeps a presentation-level spatial mask around effect companions", () => {
    const spatialMask = {};
    const spatialAlphaEffect = {};
    const presentation = mockContainer as unknown as {
      mask: unknown;
      effects: unknown[];
    };
    presentation.mask = spatialMask;
    presentation.effects = [spatialAlphaEffect];
    const state = createBaseState();
    state.feather = createFeather("hard_outer", 15);

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    expect(mockContainer.children).toHaveLength(2);
    expect(presentation.mask).toBe(spatialMask);
    expect(presentation.effects).toEqual([spatialAlphaEffect]);
  });

  it("should apply grow-only mask operation correctly", () => {
    const state = createBaseState();
    state.maskGrow = createGrow(15);

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).toBeNull();

    const bottomLayer = mockContainer.children.find((c) => c !== mockSprite);
    expect(bottomLayer).toBeDefined();
    expect(bottomLayer!.filters).toHaveLength(4); // Cleanup, Blur, Boost, Threshold
  });

  it("should allow grow + soft feather composition", () => {
    const state = createBaseState();
    state.maskGrow = createGrow(10);
    state.feather = createFeather("soft_inner", 12);

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).not.toBeNull();
    expect(mockSprite.filters).toHaveLength(2); // Cleanup and inner blur
    const mask = mockSprite.mask as Sprite;
    expect(mask.filters).toHaveLength(3); // Cleanup + grow blur + boost
  });

  it("should apply Two-way feather correctly", () => {
    const state = createBaseState();
    state.feather = createFeather("two_way", 15);

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    // Two-way keeps hard-outer underlay and adds blur on the local mask root.
    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).toBeNull();
    expect(mockSprite.filters).toEqual([]);
    expect(mockContainer.filters).toHaveLength(1);

    const bottomLayer = mockContainer.children.find((c) => c !== mockSprite);
    expect(bottomLayer).toBeDefined();
    expect(bottomLayer!.filters).toHaveLength(3); // Cleanup, Blur, and Boost
  });

});
