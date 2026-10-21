import { Container, Mesh, RenderTexture, type Renderer, type Sprite, type UniformGroup } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";
import { analyzeMaskBooleanExpression } from "../../model/maskBooleanExpression";
import { MaskSceneNodeRegistry } from "../MaskSceneNodeRegistry";
import { AssetMaskSourceFactory } from "../AssetMaskSourceFactory";
import { MaskTextureResolver } from "../MaskTextureResolver";

function createMaskClip(
  localId: string,
  maskInverted: boolean,
): MaskTimelineClip {
  return {
    id: `clip_1::mask::${localId}`,
    trackId: "track_1",
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
    parentClipId: "clip_1",
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted,
    maskParameters: { baseWidth: 100, baseHeight: 100 },
  };
}

/**
 * Resolve `expression` over vector masks and count the coverage-invert passes
 * the pipeline issued. Leaf rendering is the only place that inverts when the
 * composite state carries no edge ops.
 */
function countInvertPasses(
  expression: MaskBooleanExpression,
  maskClips: MaskTimelineClip[],
): number {
  const renderedFilters: unknown[][] = [];
  let invertedFields = 0;
  const renderer = {
    render: vi.fn(({ container }: { container: Container }) => {
      renderedFilters.push([...((container.filters as unknown[]) ?? [])]);
      if (container instanceof Mesh) {
        const group = container.shader?.resources.shapeUniforms as UniformGroup | undefined;
        if (group?.uniforms.uOutputIsField === 1 && group.uniforms.uInvertOutput === 1) {
          invertedFields += 1;
        }
      }
    }),
  } as unknown as Renderer;
  const maskContainer = new Container();
  const registry = {
    vectorMaskNodes: new Map(
      maskClips.map((clip) => [clip.id, { root: { visible: false } }]),
    ),
    assetMaskNodes: new Map(),
    getMaskContainer: () => maskContainer,
    getAssetNode: () => null,
  } as unknown as MaskSceneNodeRegistry;
  const resolver = new MaskTextureResolver(
    renderer,
    registry,
    (_sprite: Sprite) => true,
  );

  const texture = resolver.resolveCoverageTexture({
    expression,
    expressionAnalysis: analyzeMaskBooleanExpression(expression),
    maskClipByLocalId: new Map(
      maskClips.map((clip) => [clip.id.split("::mask::")[1], clip]),
    ),
    contentSize: { width: 64, height: 64 },
    compositeState: {
      compositeInvert: false,
      growAmount: 0,
      growInvert: false,
      feather: null,
    },
  });
  expect(texture).not.toBeNull();

  const invertFilter = (
    resolver as unknown as { maskCoverageInvertFilter: unknown }
  ).maskCoverageInvertFilter;
  const count = invertFilter
    ? renderedFilters.filter((filters) => filters.includes(invertFilter))
        .length
    : 0;
  resolver.dispose();
  return count + invertedFields;
}

describe("MaskTextureResolver equation-level inversion", () => {
  it("inverts a plain mask referenced as inverted", () => {
    expect(
      countInvertPasses({ kind: "mask_ref", maskId: "a", inverted: true }, [
        createMaskClip("a", false),
      ]),
    ).toBe(1);
  });

  it("passes an inverted mask through untouched when the equation inverts it again", () => {
    expect(
      countInvertPasses({ kind: "mask_ref", maskId: "a", inverted: true }, [
        createMaskClip("a", true),
      ]),
    ).toBe(0);
    expect(
      countInvertPasses({ kind: "mask_ref", maskId: "a" }, [
        createMaskClip("a", true),
      ]),
    ).toBe(1);
  });

  it("renders a mask referenced both ways as two independent leaves", () => {
    expect(
      countInvertPasses(
        {
          kind: "operation",
          operator: "union",
          left: { kind: "mask_ref", maskId: "a" },
          right: { kind: "mask_ref", maskId: "a", inverted: true },
        },
        [createMaskClip("a", false)],
      ),
    ).toBe(1);
  });
});

describe("MaskTextureResolver leaf keys", () => {
  it("gives an inverted mask and a plain mask named like its variant separate leaf textures", () => {
    // A suffix-encoded key would map plain `a::inverted` and inverted `a` to
    // one pooled texture, letting the last-rendered leaf overwrite both.
    const maskClips = [
      createMaskClip("a", false),
      createMaskClip("a::inverted", false),
    ];
    const expression: MaskBooleanExpression = {
      kind: "operation",
      operator: "intersect",
      left: { kind: "mask_ref", maskId: "a", inverted: true },
      right: { kind: "mask_ref", maskId: "a::inverted" },
    };
    const maskContainer = new Container();
    const registry = {
      vectorMaskNodes: new Map(
        maskClips.map((clip) => [clip.id, { root: { visible: false } }]),
      ),
      assetMaskNodes: new Map(),
      getMaskContainer: () => maskContainer,
      getAssetNode: () => null,
    } as unknown as MaskSceneNodeRegistry;
    const resolver = new MaskTextureResolver(
      { render: vi.fn() } as unknown as Renderer,
      registry,
      () => true,
    );

    resolver.resolveCoverageTexture({
      expression,
      expressionAnalysis: analyzeMaskBooleanExpression(expression),
      maskClipByLocalId: new Map([
        ["a", maskClips[0]],
        ["a::inverted", maskClips[1]],
      ]),
      contentSize: { width: 64, height: 64 },
      compositeState: {
        compositeInvert: false,
        growAmount: 0,
        growInvert: false,
        feather: null,
      },
    });

    const pool = (
      resolver as unknown as {
        pool: { getLeafMaskRenderTextures(): ReadonlyMap<string, unknown> };
      }
    ).pool;
    expect(pool.getLeafMaskRenderTextures().size).toBe(2);
    resolver.dispose();
  });
});

describe("MaskTextureResolver field re-distance selection", () => {
  it("skips only outside-exact union ramps and re-evaluates the rule on every resolve", () => {
    let seeds = 0;
    const renderer = {
      render: vi.fn(({ container }: { container: Container }) => {
        if (container instanceof Mesh && container.shader?.resources.seedUniforms) seeds += 1;
      }),
    } as unknown as Renderer;
    const container = new Container();
    const registry = new MaskSceneNodeRegistry(container, new AssetMaskSourceFactory(renderer), () => true);
    const frames = [RenderTexture.create({ width: 64, height: 64 }), RenderTexture.create({ width: 64, height: 64 })];
    registry.reconcileAssetMaskNodes(["a", "b"].map((id) => ({ maskId: id, assetId: id, kind: "image" })));
    const clips = ["a", "b"].map((id, index) => {
      const node = registry.getAssetNode(id);
      if (!node) throw new Error("test node missing");
      node.player.sprite.texture = frames[index];
      node.player.sprite.visible = true;
      node.decodeFilter.setEncoding("tsdf8_k8");
      return { ...createMaskClip(id, false), id, maskType: "sam2" as const };
    });
    const resolver = new MaskTextureResolver(renderer, registry, () => true);
    const expression: MaskBooleanExpression = {
      kind: "operation", operator: "union",
      left: { kind: "mask_ref", maskId: "a" }, right: { kind: "mask_ref", maskId: "b" },
    };
    const cases = [
      { growAmount: 4, feather: null, expectedSeeds: 0 },
      { growAmount: -4, feather: null, expectedSeeds: 1 },
      { growAmount: 0, feather: { amount: 8, mode: "hard_outer" as const, invert: false }, expectedSeeds: 0 },
      { growAmount: 0, feather: { amount: 8, mode: "soft_inner" as const, invert: false }, expectedSeeds: 1 },
      { growAmount: 0, feather: null, expectedSeeds: 1 },
      { growAmount: 30, feather: null, expectedSeeds: 1 },
    ];
    for (const { expectedSeeds, ...edgeOps } of cases) {
      seeds = 0;
      const texture = resolver.resolveCoverageTexture({
        expression, expressionAnalysis: analyzeMaskBooleanExpression(expression),
        maskClipByLocalId: new Map(clips.map((clip) => [clip.id, clip])),
        contentSize: { width: 64, height: 64 },
        compositeState: { compositeInvert: false, growInvert: false, ...edgeOps },
      });
      expect(texture).not.toBeNull();
      expect(seeds, JSON.stringify(edgeOps)).toBe(expectedSeeds);
    }
    resolver.dispose();
    registry.reconcileAssetMaskNodes([]);
    container.destroy({ children: true });
    frames.forEach((frame) => frame.destroy(true));
  });
});

describe("MaskTextureResolver draw budgets", () => {
  it.each([
    { label: "brush + circle, no edge ops", types: ["brush", "circle"], grow: 0, repeated: false, draws: 26 },
    { label: "union(brush, brush), one distinct leaf", types: ["brush"], grow: 0, repeated: true, draws: 16 },
    { label: "two stored SAM2 bands, no edge ops", types: ["sam2", "sam2"], grow: 0, repeated: false, draws: 10 },
    { label: "two stored SAM2 bands, outside grow", types: ["sam2", "sam2"], grow: 4, repeated: false, draws: 6 },
  ] as const)("keeps the per-frame budget for $label", ({ types, grow, repeated, draws }) => {
    const render = vi.fn();
    const renderer = { render } as unknown as Renderer;
    const container = new Container();
    const registry = new MaskSceneNodeRegistry(container, new AssetMaskSourceFactory(renderer), () => true);
    const clips = types.map((maskType, index) => ({
      ...createMaskClip(String(index), false), id: String(index), maskType,
    }));
    registry.reconcileVectorNodes(clips.filter((clip) => clip.maskType === "circle").map((clip) => clip.id));
    registry.reconcileAssetMaskNodes(clips.filter((clip) => clip.maskType !== "circle").map((clip) => ({
      maskId: clip.id, assetId: clip.id, kind: "image",
    })));
    const frames: RenderTexture[] = [];
    for (const clip of clips) {
      const node = registry.getAssetNode(clip.id);
      if (!node) continue;
      const frame = RenderTexture.create({ width: 64, height: 64 });
      frames.push(frame);
      node.player.sprite.texture = frame;
      node.player.sprite.visible = true;
      node.decodeFilter.setEncoding(clip.maskType === "sam2" ? "tsdf8_k8" : "binary");
    }
    const resolver = new MaskTextureResolver(renderer, registry, () => true);
    const expression: MaskBooleanExpression = {
      kind: "operation", operator: "union",
      left: { kind: "mask_ref", maskId: "0" },
      right: { kind: "mask_ref", maskId: repeated ? "0" : "1" },
    };
    // Fixed budgets intentionally do not reuse the pass-planning helpers:
    // an extra draw in either the leaves or the final shaping must fail here.
    for (let frame = 0; frame < 2; frame++) {
      render.mockClear();
      expect(resolver.resolveCoverageTexture({
        expression, expressionAnalysis: analyzeMaskBooleanExpression(expression),
        maskClipByLocalId: new Map(clips.map((clip) => [clip.id, clip])),
        contentSize: { width: 64, height: 64 },
        compositeState: { compositeInvert: false, growAmount: grow, growInvert: false, feather: null },
      })).not.toBeNull();
      expect(render).toHaveBeenCalledTimes(draws);
    }
    resolver.dispose();
    registry.reconcileAssetMaskNodes([]);
    registry.reconcileVectorNodes([]);
    container.destroy({ children: true });
    frames.forEach((frame) => frame.destroy(true));
  });

  it.each(["brush", "circle", "sam2"] as const)(
    "uses the same seed policy for a single %s and its repeated union",
    (maskType) => {
      const smoothCoverage: number[] = [];
      const renderer = {
        render: vi.fn(({ container }: { container: Container }) => {
          if (container instanceof Mesh && container.shader?.resources.seedUniforms) {
            const group = container.shader.resources.seedUniforms as UniformGroup;
            const smooth = group.uniforms.uSmoothCoverage;
            if (typeof smooth !== "number") throw new Error("seed mode missing");
            smoothCoverage.push(smooth);
          }
        }),
      } as unknown as Renderer;
      const container = new Container();
      const registry = new MaskSceneNodeRegistry(container, new AssetMaskSourceFactory(renderer), () => true);
      const clip = { ...createMaskClip("a", false), id: "a", maskType };
      const frame = RenderTexture.create({ width: 64, height: 64 });
      if (maskType === "circle") registry.reconcileVectorNodes(["a"]);
      else {
        registry.reconcileAssetMaskNodes([{ maskId: "a", assetId: "a", kind: "image" }]);
        const node = registry.getAssetNode("a");
        if (!node) throw new Error("test node missing");
        node.player.sprite.texture = frame;
        node.player.sprite.visible = true;
      }
      const resolver = new MaskTextureResolver(renderer, registry, () => true);
      const leaf: MaskBooleanExpression = { kind: "mask_ref", maskId: "a" };
      const expressions: MaskBooleanExpression[] = [leaf, { kind: "operation", operator: "union", left: leaf, right: leaf }];
      for (const expression of expressions) {
        smoothCoverage.length = 0;
        resolver.resolveCoverageTexture({
          expression, expressionAnalysis: analyzeMaskBooleanExpression(expression),
          maskClipByLocalId: new Map([["a", clip]]), contentSize: { width: 64, height: 64 },
          compositeState: { compositeInvert: false, growAmount: 4, growInvert: false, feather: null },
        });
        expect(smoothCoverage).toEqual([maskType === "sam2" ? 1 : 0]);
      }
      resolver.dispose();
      registry.reconcileAssetMaskNodes([]);
      registry.reconcileVectorNodes([]);
      container.destroy({ children: true });
      frame.destroy(true);
    },
  );
});
