import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TransformState, ClipTransformTarget } from "../types";

const { MockFilter } = vi.hoisted(() => {
  return {
    MockFilter: class {
      blur: number = 0;
      matrix: number[] = [];
    },
  };
});

// Mock internal Pixi components used by the applicator
vi.mock("pixi.js", () => {
  const MOCK_TEXTURE = {
    width: 100,
    height: 100,
    source: {},
    _source: { alphaMode: "premultiply-alpha-on-upload" },
  };
  const TEXTURE_EMPTY = {
    width: 0,
    height: 0,
    source: {},
    _source: { alphaMode: "premultiply-alpha-on-upload" },
  };
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
    BlurFilter: class extends MockFilter {
      blur: number = 0;
      strength: number = 0;
    },
    ColorMatrixFilter: class extends MockFilter {
      matrix: number[] = [];
    },
    Container: class {
      children: unknown[] = [];
      parent: unknown = null;
      filters: unknown[] | null = null;
      addChild(child: unknown) {
        this.children.push(child);
        (child as { parent: unknown }).parent = this;
      }
      addChildAt(child: unknown, index: number) {
        this.children.splice(index, 0, child);
        (child as { parent: unknown }).parent = this;
      }
      getChildIndex(child: unknown) {
        return this.children.indexOf(child);
      }
      removeChild(child: unknown) {
        const index = this.children.indexOf(child);
        if (index > -1) {
          this.children.splice(index, 1);
        }
        (child as { parent: unknown | null }).parent = null;
      }
    },
    Sprite: class {
      parent: unknown = null;
      texture: typeof MOCK_TEXTURE = MOCK_TEXTURE;
      mask: unknown = null;
      filters: unknown[] | null = null;
      renderable: boolean = true;
      alpha: number = 1;
      position = { copyFrom: vi.fn() };
      scale = { copyFrom: vi.fn() };
      rotation = 0;
      anchor = { copyFrom: vi.fn() };
      pivot = { copyFrom: vi.fn() };
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
    state.feather = { mode: "soft_inner", amount: 10 };
    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    // Soft inner adds a non-renderable self-mask companion.
    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).not.toBeNull();

    // 2. Tear it down
    state.feather.amount = 0;
    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    expect(mockSprite.mask).toBeNull();
    // The rig sprites should have their destroy() method called
    // We cannot easily check internal rig state here outside of the destroy spies
    // but we can ensure the mask is detached.
  });

  it("should apply Soft feather correctly", () => {
    const state = createBaseState();
    state.feather = { mode: "soft_inner", amount: 20 };

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
    state.feather = { mode: "hard_outer", amount: 15 };

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    // Outer attaches the bottomLayer to the container but drops the mask
    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).toBeNull();

    // The bottom layer should have Blur and Boost filters
    const bottomLayer = mockContainer.children.find((c) => c !== mockSprite);
    expect(bottomLayer).toBeDefined();
    expect(bottomLayer!.filters).toHaveLength(3); // Cleanup, Blur, and Boost
  });

  it("should apply grow-only mask operation correctly", () => {
    const state = createBaseState();
    state.maskGrow = { amount: 15 };

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).toBeNull();

    const bottomLayer = mockContainer.children.find((c) => c !== mockSprite);
    expect(bottomLayer).toBeDefined();
    expect(bottomLayer!.filters).toHaveLength(4); // Cleanup, Blur, Boost, Threshold
  });

  it("should allow grow + soft feather composition", () => {
    const state = createBaseState();
    state.maskGrow = { amount: 10 };
    state.feather = { mode: "soft_inner", amount: 12 };

    featherApplicator(mockSprite as unknown as ClipTransformTarget, state);

    expect(mockContainer.children).toHaveLength(2);
    expect(mockSprite.mask).not.toBeNull();
    expect(mockSprite.filters).toHaveLength(2); // Cleanup and inner blur
    const mask = mockSprite.mask as Sprite;
    expect(mask.filters).toHaveLength(3); // Cleanup + grow blur + boost
  });

  it("should apply Two-way feather correctly", () => {
    const state = createBaseState();
    state.feather = { mode: "two_way", amount: 15 };

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
