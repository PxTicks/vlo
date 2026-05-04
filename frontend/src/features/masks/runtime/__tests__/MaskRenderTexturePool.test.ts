import { describe, expect, it } from "vitest";
import { MaskRenderTexturePool } from "../MaskRenderTexturePool";

describe("MaskRenderTexturePool", () => {
  it("resizes pooled textures and clears them on dispose", () => {
    const pool = new MaskRenderTexturePool();
    pool.ensureMaskRenderTexture({ width: 120, height: 80 });
    pool.ensurePerMaskRenderTexture({ width: 120, height: 80 });
    pool.ensureEffectMaskRenderTexture({ width: 120, height: 80 });
    pool.ensurePresentationMaskRenderTexture({ width: 120, height: 80 });
    pool.reconcileLeafMaskRenderTextures(["mask_a"], { width: 120, height: 80 });

    const maskTexture = pool.getMaskRenderTexture();
    const perMaskTexture = pool.getPerMaskRenderTexture();
    const effectTexture = pool.getEffectMaskRenderTexture();
    const presentationTexture = pool.getPresentationMaskRenderTexture();
    const leafTexture = pool.getLeafMaskRenderTexture("mask_a");

    pool.ensureMaskRenderTexture({ width: 240, height: 160 });
    pool.ensurePerMaskRenderTexture({ width: 240, height: 160 });
    pool.ensureEffectMaskRenderTexture({ width: 240, height: 160 });
    pool.ensurePresentationMaskRenderTexture({ width: 240, height: 160 });
    pool.reconcileLeafMaskRenderTextures(["mask_a"], { width: 240, height: 160 });

    expect(pool.getMaskRenderTexture()).toBe(maskTexture);
    expect(pool.getMaskRenderTexture()?.width).toBe(240);
    expect(pool.getPerMaskRenderTexture()).toBe(perMaskTexture);
    expect(pool.getPerMaskRenderTexture()?.height).toBe(160);
    expect(pool.getEffectMaskRenderTexture()).toBe(effectTexture);
    expect(pool.getPresentationMaskRenderTexture()).toBe(presentationTexture);
    expect(pool.getLeafMaskRenderTexture("mask_a")).toBe(leafTexture);

    pool.dispose();

    expect(maskTexture?.destroyed).toBe(true);
    expect(perMaskTexture?.destroyed).toBe(true);
    expect(effectTexture?.destroyed).toBe(true);
    expect(presentationTexture?.destroyed).toBe(true);
    expect(leafTexture?.destroyed).toBe(true);
    expect(pool.getMaskRenderTexture()).toBeNull();
    expect(pool.getLeafMaskRenderTextures().size).toBe(0);
  });

  it("shrinks and expands expression textures in place", () => {
    const pool = new MaskRenderTexturePool();

    pool.ensureExpressionRenderTextureCount(3, { width: 120, height: 80 });
    const initialTextures = [...pool.getExpressionRenderTextures()];

    pool.ensureExpressionRenderTextureCount(1, { width: 120, height: 80 });
    expect(pool.getExpressionRenderTextures()).toHaveLength(1);
    expect(initialTextures[1]?.destroyed).toBe(true);
    expect(initialTextures[2]?.destroyed).toBe(true);

    pool.ensureExpressionRenderTextureCount(4, { width: 240, height: 160 });
    expect(pool.getExpressionRenderTextures()).toHaveLength(4);
    expect(pool.getExpressionRenderTextures()[0]).toBe(initialTextures[0]);
    expect(pool.getExpressionRenderTextures()[0]?.width).toBe(240);
    expect(pool.getExpressionRenderTextures()[3]?.height).toBe(160);

    pool.dispose();
  });
});
