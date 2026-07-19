import type { JsonValue } from "../types";
import { jsonValueSchema } from "../persistence/extensionPayload";

/**
 * Byte budget per extension namespace (serialized JSON). Documented SDK
 * behaviour: exceeding it makes `set()` reject; existing data is untouched.
 */
export const EXTENSION_STORAGE_NAMESPACE_BUDGET_BYTES = 5 * 1024 * 1024;
const MAX_STORAGE_KEY_LENGTH = 128;
const DEFAULT_WRITE_DEBOUNCE_MS = 500;

export interface ExtensionProjectStorageIo {
  /** Reads the whole persisted document's namespaces. */
  readNamespaces(): Promise<Record<string, Record<string, JsonValue>>>;
  /** Replaces one extension's namespace; undefined deletes it. */
  writeNamespace(
    extensionId: string,
    record: Record<string, JsonValue> | undefined,
  ): Promise<unknown>;
}

export function assertStorageKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_STORAGE_KEY_LENGTH ||
    key.includes("/")
  ) {
    throw new Error(
      `Storage keys must be 1-${MAX_STORAGE_KEY_LENGTH} characters without "/".`,
    );
  }
}

export function cloneStorageValue(value: JsonValue): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Storage values must be finite JSON.");
  }
  return freezeStorageValue(structuredClone(parsed.data));
}

function freezeStorageValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const item of value) freezeStorageValue(item);
    Object.freeze(value);
    return value;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeStorageValue(item);
    return Object.freeze(value);
  }
  return value;
}

function serializedByteLength(
  value: JsonValue | Record<string, JsonValue>,
): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * In-memory projection of the project's extension-storage document
 * (extension-shell-surfaces plan §4). Hydrated on project open; writes are
 * namespace-granular and debounced into the persistence queue. Namespaces of
 * uninstalled extensions are hydrated and retained untouched. Storage never
 * participates in undo history.
 */
export class ExtensionProjectStorage {
  private readonly namespaces = new Map<string, Record<string, JsonValue>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly pendingWrites = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly dirtyNamespaces = new Set<string>();
  private readonly inFlightWrites = new Map<string, Promise<void>>();
  private open = false;
  private readonly io: ExtensionProjectStorageIo;
  private readonly debounceMs: number;

  constructor(
    io: ExtensionProjectStorageIo,
    debounceMs: number = DEFAULT_WRITE_DEBOUNCE_MS,
  ) {
    this.io = io;
    this.debounceMs = debounceMs;
  }

  async openForProject(): Promise<void> {
    const loaded = await this.io.readNamespaces();
    this.namespaces.clear();
    for (const [extensionId, record] of Object.entries(loaded)) {
      this.namespaces.set(extensionId, structuredClone(record));
    }
    this.open = true;
    this.notifyAll();
  }

  async closeProject(): Promise<void> {
    if (!this.open) return;
    // Fail closed before awaiting persistence so callers cannot mutate this
    // projection while its final snapshot is being written.
    this.open = false;
    try {
      await this.flush();
    } finally {
      this.clearPendingTimers();
      this.dirtyNamespaces.clear();
      this.namespaces.clear();
      this.notifyAll();
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  get(extensionId: string, key: string): JsonValue | undefined {
    assertStorageKey(key);
    this.assertOpen();
    const value = this.namespaces.get(extensionId)?.[key];
    return value === undefined ? undefined : cloneStorageValue(value);
  }

  set(extensionId: string, key: string, value: JsonValue): void {
    assertStorageKey(key);
    this.assertOpen();
    const cloned = cloneStorageValue(value);
    const current = this.namespaces.get(extensionId) ?? {};
    const next = { ...current, [key]: cloned };
    const size = serializedByteLength(next);
    if (size > EXTENSION_STORAGE_NAMESPACE_BUDGET_BYTES) {
      throw new Error(
        `Project storage for '${extensionId}' would exceed its ` +
          `${EXTENSION_STORAGE_NAMESPACE_BUDGET_BYTES}-byte budget.`,
      );
    }
    this.namespaces.set(extensionId, next);
    this.dirtyNamespaces.add(extensionId);
    this.scheduleWrite(extensionId);
    this.notify(extensionId);
  }

  delete(extensionId: string, key: string): void {
    assertStorageKey(key);
    this.assertOpen();
    const current = this.namespaces.get(extensionId);
    if (!current || !(key in current)) return;
    const next = { ...current };
    delete next[key];
    if (Object.keys(next).length === 0) {
      this.namespaces.delete(extensionId);
    } else {
      this.namespaces.set(extensionId, next);
    }
    this.dirtyNamespaces.add(extensionId);
    this.scheduleWrite(extensionId);
    this.notify(extensionId);
  }

  keys(extensionId: string): readonly string[] {
    this.assertOpen();
    return Object.keys(this.namespaces.get(extensionId) ?? {});
  }

  subscribe(extensionId: string, listener: () => void): () => void {
    let scoped = this.listeners.get(extensionId);
    if (!scoped) {
      scoped = new Set();
      this.listeners.set(extensionId, scoped);
    }
    scoped.add(listener);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) this.listeners.delete(extensionId);
    };
  }

  /** Forces pending namespace writes now (project close, tests). */
  async flush(): Promise<void> {
    this.clearPendingTimers();

    // A debounce may already have promoted a write to the persistence queue.
    // Wait for it before deciding which dirty namespaces need a final retry.
    await Promise.allSettled([...this.inFlightWrites.values()]);
    await Promise.all(
      [...this.dirtyNamespaces].map((extensionId) =>
        this.queueNamespaceWrite(extensionId),
      ),
    );
  }

  private assertOpen(): void {
    if (!this.open) {
      throw new Error("Project storage is unavailable: no project is open.");
    }
  }

  private scheduleWrite(extensionId: string): void {
    const existing = this.pendingWrites.get(extensionId);
    if (existing !== undefined) clearTimeout(existing);
    this.pendingWrites.set(
      extensionId,
      setTimeout(() => {
        this.pendingWrites.delete(extensionId);
        void this.queueNamespaceWrite(extensionId).catch((error: unknown) => {
          console.error(
            `[ExtensionStorage] Failed to persist project storage for '${extensionId}'.`,
            error,
          );
        });
      }, this.debounceMs),
    );
  }

  private queueNamespaceWrite(extensionId: string): Promise<void> {
    const previous = this.inFlightWrites.get(extensionId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.writeDirtyNamespace(extensionId));
    this.inFlightWrites.set(extensionId, write);
    void write.then(
      () => {
        if (this.inFlightWrites.get(extensionId) === write) {
          this.inFlightWrites.delete(extensionId);
        }
      },
      () => {
        if (this.inFlightWrites.get(extensionId) === write) {
          this.inFlightWrites.delete(extensionId);
        }
      },
    );
    return write;
  }

  private async writeDirtyNamespace(extensionId: string): Promise<void> {
    if (!this.dirtyNamespaces.has(extensionId)) return;
    const record = this.namespaces.get(extensionId);
    const snapshot = record === undefined ? undefined : structuredClone(record);
    this.dirtyNamespaces.delete(extensionId);
    try {
      await this.io.writeNamespace(extensionId, snapshot);
    } catch (error) {
      this.dirtyNamespaces.add(extensionId);
      throw error;
    }
  }

  private clearPendingTimers(): void {
    for (const timer of this.pendingWrites.values()) clearTimeout(timer);
    this.pendingWrites.clear();
  }

  private notify(extensionId: string): void {
    for (const listener of this.listeners.get(extensionId) ?? []) {
      try {
        listener();
      } catch {
        // Owner-scoped isolation with diagnostics wraps these in the adapter.
      }
    }
  }

  private notifyAll(): void {
    for (const extensionId of [...this.listeners.keys()]) {
      this.notify(extensionId);
    }
  }
}
