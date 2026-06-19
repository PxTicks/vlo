import { describe, it, expect } from "vitest";
import { EffectChainTexturePool } from "../EffectChainTexturePool";

/**
 * Ping-pong pool for the masked-effect chain: three content-sized targets, and
 * acquireExcluding never returns a live (excluded) texture.
 */

const SIZE = { width: 64, height: 48 };

describe("EffectChainTexturePool", () => {
  it("creates three targets and never returns an excluded one", () => {
    const pool = new EffectChainTexturePool();
    pool.ensure(SIZE);
    expect(pool.count).toBe(3);

    const t0 = pool.acquireExcluding();
    const t1 = pool.acquireExcluding(t0);
    const t2 = pool.acquireExcluding(t0, t1);

    expect(t1).not.toBe(t0);
    expect(t2).not.toBe(t0);
    expect(t2).not.toBe(t1);
  });

  it("throws when more textures are live than targets exist", () => {
    const pool = new EffectChainTexturePool();
    pool.ensure(SIZE);
    const t0 = pool.acquireExcluding();
    const t1 = pool.acquireExcluding(t0);
    const t2 = pool.acquireExcluding(t0, t1);
    expect(() => pool.acquireExcluding(t0, t1, t2)).toThrow(/exhausted/);
    pool.dispose();
  });

  it("is idempotent for the same size and recreates on a size change", () => {
    const pool = new EffectChainTexturePool();
    pool.ensure(SIZE);
    const t0 = pool.acquireExcluding();

    pool.ensure(SIZE); // same size -> no recreate
    expect(pool.acquireExcluding()).toBe(t0);

    pool.ensure({ width: 128, height: 96 }); // changed -> recreate
    expect((t0 as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(pool.acquireExcluding()).not.toBe(t0);

    pool.dispose();
  });

  it("destroys all targets on dispose", () => {
    const pool = new EffectChainTexturePool();
    pool.ensure(SIZE);
    const t0 = pool.acquireExcluding();
    pool.dispose();
    expect(pool.count).toBe(0);
    expect((t0 as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});
