import { Texture } from "pixi.js";
import { destroyTexture } from "../utils/retiredTextureQueue";

/**
 * The resource a first-time acquisition creates for a decode key: the shared
 * Pixi texture plus how to fully free it. `dispose` runs exactly once, when the
 * last reference is released; it defaults to destroying the texture (and its
 * source). Override it to also close the backing `ImageBitmap`, so the store
 * owns the *source*, not just the texture — the bitmap stays alive until every
 * consumer has released.
 */
export interface SharedTextureResource {
  texture: Texture;
  dispose?: () => void;
}

interface ResidentEntry {
  decodeKey: string;
  texture: Texture;
  dispose: () => void;
  refCount: number;
  disposed: boolean;
}

/**
 * A reference handle to a resident shared texture. One handle is issued per
 * `acquire`, and {@link release} is the *only* way to give that reference back.
 *
 * The handle owns no store state and exposes no way to mutate the registry: its
 * release logic is a closure bound, at construction, to the store that issued
 * it and the specific entry it referenced. So a handle can only ever affect its
 * own store's count for its own entry, releasing is idempotent (a second call
 * is a no-op, never an over-decrement), and there is no public seam a caller
 * can misuse to mark a handle released without decrementing/disposing.
 */
export class SharedTextureHandle {
  readonly decodeKey: string;
  readonly texture: Texture;
  private released = false;
  private readonly onRelease: () => void;

  /** @internal — constructed only by {@link SharedTextureStore}. */
  constructor(decodeKey: string, texture: Texture, onRelease: () => void) {
    this.decodeKey = decodeKey;
    this.texture = texture;
    this.onRelease = onRelease;
  }

  /** Return this reference to its store. Idempotent. */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.onRelease();
  }
}

/**
 * Reference-counted registry of decoded source-frame textures, keyed by
 * `decodeKey` (see `sourceFrameSync`). It makes "decode once, share across N
 * clip instances" safe: the first consumer wraps the decoded frame into one
 * immutable texture; every later consumer at the same `decodeKey` shares it;
 * the texture (and its source) is freed only when the last reference releases.
 *
 * The store is the sole owner of the textures it holds. Consumers receive a
 * handle and must call `handle.release()`; they must never `destroy` or retire
 * a shared texture themselves. The engine's existing retire path should skip
 * textures for which {@link owns} is true (the Phase 4 release-vs-retire seam).
 *
 * This is a synchronous lifetime primitive: it does not decode. In-flight
 * decode coalescing is `SourceFrameDecodeScheduler`'s job; the planner (Phase
 * 4) composes the two — scheduler decodes a frame once, the store wraps and
 * ref-counts the resulting texture.
 */
export class SharedTextureStore {
  private readonly byKey = new Map<string, ResidentEntry>();
  private readonly byTexture = new Map<Texture, ResidentEntry>();

  /** Number of resident (non-zero-ref) textures. Diagnostics/tests. */
  get size(): number {
    return this.byKey.size;
  }

  /**
   * Acquire a reference to the shared texture for `decodeKey`, creating it via
   * `create` on first acquisition only. Returns a handle the caller must
   * eventually `release`.
   */
  acquire(
    decodeKey: string,
    create: () => SharedTextureResource,
  ): SharedTextureHandle {
    let entry = this.byKey.get(decodeKey);
    if (!entry) {
      const resource = create();
      const texture = resource.texture;
      const dispose = resource.dispose ?? (() => destroyTexture(texture));
      entry = { decodeKey, texture, dispose, refCount: 0, disposed: false };
      this.byKey.set(decodeKey, entry);
      this.byTexture.set(texture, entry);
    }
    entry.refCount += 1;
    const owned = entry;
    return new SharedTextureHandle(decodeKey, owned.texture, () =>
      this.releaseEntry(owned),
    );
  }

  /**
   * Give back one reference to `entry`. When its last reference is released the
   * texture is evicted and disposed. Invoked only through a handle's bound
   * release closure, exactly once per handle, so the count cannot drift.
   */
  private releaseEntry(entry: ResidentEntry): void {
    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }
    // Last reference: evict before disposing so a re-acquire during/after
    // disposal starts a fresh residency rather than reviving a dead entry.
    if (this.byKey.get(entry.decodeKey) === entry) {
      this.byKey.delete(entry.decodeKey);
    }
    this.disposeEntry(entry);
  }

  /** Idempotently free an entry's resource and drop its texture mapping. */
  private disposeEntry(entry: ResidentEntry): void {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    this.byTexture.delete(entry.texture);
    entry.dispose();
  }

  /** Whether this store currently owns `texture` (the engine retire seam). */
  owns(texture: Texture | null | undefined): boolean {
    return !!texture && texture !== Texture.EMPTY && this.byTexture.has(texture);
  }

  /** Live reference count for `decodeKey` (0 if not resident). Tests. */
  refCount(decodeKey: string): number {
    return this.byKey.get(decodeKey)?.refCount ?? 0;
  }

  /**
   * Force-dispose every resident texture (e.g. on renderer teardown). Handles
   * still held become inert: their later `release` is a safe no-op because the
   * entry is gone.
   */
  dispose(): void {
    for (const entry of this.byKey.values()) {
      this.disposeEntry(entry);
    }
    this.byKey.clear();
    this.byTexture.clear();
  }
}
