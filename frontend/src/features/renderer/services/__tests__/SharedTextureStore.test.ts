import { describe, it, expect, vi } from "vitest";
import { Texture } from "pixi.js";
import { SharedTextureStore } from "../SharedTextureStore";

/**
 * Phase 2 shared texture lifetime. The store is the sole owner of the textures
 * it holds: one decode -> one texture -> N shared references, freed only when
 * the last reference releases. Tests use Texture-shaped fakes (no GPU): the
 * store only touches identity, `.destroyed`, and `.destroy`.
 */

interface FakeTexture {
  destroyed: boolean;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeTexture(): FakeTexture & Texture {
  const tex = {
    destroyed: false,
    destroy: vi.fn(function destroy(this: FakeTexture) {
      this.destroyed = true;
    }),
  };
  return tex as unknown as FakeTexture & Texture;
}

const KEY = "asset-1:2:30:0.066";

describe("SharedTextureStore", () => {
  it("creates the texture once and shares it across acquisitions at one decodeKey", () => {
    const store = new SharedTextureStore();
    const create = vi.fn(() => ({ texture: fakeTexture() }));

    const a = store.acquire(KEY, create);
    const b = store.acquire(KEY, create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(a.texture).toBe(b.texture);
    expect(store.refCount(KEY)).toBe(2);
    expect(store.size).toBe(1);
  });

  it("keeps distinct textures for distinct decodeKeys", () => {
    const store = new SharedTextureStore();
    const a = store.acquire("asset-1:2:30:0.066", () => ({ texture: fakeTexture() }));
    const b = store.acquire("asset-2:2:30:0.066", () => ({ texture: fakeTexture() }));

    expect(a.texture).not.toBe(b.texture);
    expect(store.size).toBe(2);
  });

  it("does not dispose the texture until the last reference is released", () => {
    const store = new SharedTextureStore();
    const texture = fakeTexture();
    const a = store.acquire(KEY, () => ({ texture }));
    const b = store.acquire(KEY, () => ({ texture }));

    a.release();
    expect(texture.destroy).not.toHaveBeenCalled();
    expect(store.refCount(KEY)).toBe(1);
    expect(store.owns(texture)).toBe(true);

    b.release();
    expect(texture.destroy).toHaveBeenCalledTimes(1);
    expect(texture.destroyed).toBe(true);
    expect(store.refCount(KEY)).toBe(0);
    expect(store.owns(texture)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("runs a custom dispose exactly once on final release (closes the source bitmap)", () => {
    const store = new SharedTextureStore();
    const texture = fakeTexture();
    const close = vi.fn();
    const dispose = vi.fn(() => {
      texture.destroy(true);
      close();
    });

    const a = store.acquire(KEY, () => ({ texture, dispose }));
    const b = store.acquire(KEY, () => ({ texture, dispose }));

    a.release();
    expect(dispose).not.toHaveBeenCalled();
    b.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("treats a double release of the same handle as a no-op", () => {
    const store = new SharedTextureStore();
    const texture = fakeTexture();
    const a = store.acquire(KEY, () => ({ texture }));
    const b = store.acquire(KEY, () => ({ texture }));

    a.release();
    a.release(); // duplicate — must not over-decrement
    expect(texture.destroy).not.toHaveBeenCalled();
    expect(store.refCount(KEY)).toBe(1);

    b.release();
    expect(texture.destroy).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh residency when a key is re-acquired after full release", () => {
    const store = new SharedTextureStore();
    const first = fakeTexture();
    const second = fakeTexture();
    const create = vi
      .fn()
      .mockImplementationOnce(() => ({ texture: first }))
      .mockImplementationOnce(() => ({ texture: second }));

    const a = store.acquire(KEY, create);
    a.release();
    expect(first.destroyed).toBe(true);

    const b = store.acquire(KEY, create);
    expect(create).toHaveBeenCalledTimes(2);
    expect(b.texture).toBe(second);
    expect(second.destroyed).toBe(false);
  });

  it("disposes via handle.release() as the only release path", () => {
    const store = new SharedTextureStore();
    const texture = fakeTexture();
    const a = store.acquire(KEY, () => ({ texture }));

    a.release();
    expect(texture.destroy).toHaveBeenCalledTimes(1);
    expect(store.owns(texture)).toBe(false);
  });

  it("exposes no public seam to release/claim outside handle.release()", () => {
    const store = new SharedTextureStore();
    const handle = store.acquire(KEY, () => ({ texture: fakeTexture() }));

    // The encapsulation hole this guards: a caller must not be able to mark a
    // handle released (or release it through a foreign store) without going
    // through its own bound release closure.
    expect(
      (store as unknown as { release?: unknown }).release,
    ).toBeUndefined();
    expect(
      (handle as unknown as { claim?: unknown }).claim,
    ).toBeUndefined();
  });

  it("exposes decodeKey on the handle", () => {
    const store = new SharedTextureStore();
    const handle = store.acquire(KEY, () => ({ texture: fakeTexture() }));
    expect(handle.decodeKey).toBe(KEY);
  });

  it("owns() is false for null and Texture.EMPTY", () => {
    const store = new SharedTextureStore();
    expect(store.owns(null)).toBe(false);
    expect(store.owns(Texture.EMPTY)).toBe(false);
  });

  it("dispose() frees all residents and makes outstanding handle releases inert", () => {
    const store = new SharedTextureStore();
    const t1 = fakeTexture();
    const t2 = fakeTexture();
    const close = vi.fn();
    const a = store.acquire("k1", () => ({
      texture: t1,
      dispose: () => {
        t1.destroy(true);
        close();
      },
    }));
    store.acquire("k2", () => ({ texture: t2 }));

    store.dispose();
    expect(t1.destroyed).toBe(true);
    expect(t2.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);

    // A handle held across teardown can still be released safely — the custom
    // dispose must NOT run a second time.
    a.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not leak an entry when the create factory throws", () => {
    const store = new SharedTextureStore();
    expect(() =>
      store.acquire(KEY, () => {
        throw new Error("create boom");
      }),
    ).toThrow("create boom");
    expect(store.size).toBe(0);
    expect(store.refCount(KEY)).toBe(0);
  });
});
