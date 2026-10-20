import { RenderTexture, type Renderer, type Shader } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { resolveMaskEdgeShape } from "../../../utils/maskEdgeProfile";
import { MaskDistanceFieldRenderer } from "../MaskDistanceFieldRenderer";

type PassShaders = Record<"seed" | "flood" | "shape", { shader: Shader }>;

function passShaders(renderer: MaskDistanceFieldRenderer): Shader[] {
  const passes = (renderer as unknown as { passes: PassShaders | null }).passes;
  if (!passes) throw new Error("passes were not created");
  return [passes.seed.shader, passes.flood.shader, passes.shape.shader];
}

describe("MaskDistanceFieldRenderer", () => {
  it("keeps the shared cached programs alive when one renderer is disposed", () => {
    // One renderer per clip's mask resolver: they all share the programs
    // GlProgram.from caches by source.
    const pixiRenderer = { render: vi.fn() } as unknown as Renderer;
    const coverage = RenderTexture.create({ width: 8, height: 8 });
    const target = RenderTexture.create({ width: 8, height: 8 });
    const shape = resolveMaskEdgeShape({ growPx: 2, growInvert: false, feather: null });
    const disposed = new MaskDistanceFieldRenderer(pixiRenderer);
    const survivor = new MaskDistanceFieldRenderer(pixiRenderer);
    disposed.render(coverage, target, shape);
    survivor.render(coverage, target, shape);

    const sharedPrograms = passShaders(survivor).map((shader) => shader.glProgram);
    expect(passShaders(disposed).map((shader) => shader.glProgram)).toEqual(
      sharedPrograms,
    );

    disposed.dispose();

    for (const program of sharedPrograms) {
      expect(program.vertex).toBeTruthy();
      expect(program.fragment).toBeTruthy();
    }
    expect(() => survivor.render(coverage, target, shape)).not.toThrow();

    survivor.dispose();
    coverage.destroy(true);
    target.destroy(true);
  });
});
