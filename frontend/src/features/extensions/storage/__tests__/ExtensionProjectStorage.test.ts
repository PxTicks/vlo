import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../types";
import {
  EXTENSION_STORAGE_NAMESPACE_BUDGET_BYTES,
  ExtensionProjectStorage,
  type ExtensionProjectStorageIo,
} from "../ExtensionProjectStorage";

function createIo(
  initial: Record<string, Record<string, JsonValue>> = {},
): ExtensionProjectStorageIo & {
  readonly writes: Array<[string, Record<string, JsonValue> | undefined]>;
} {
  const writes: Array<[string, Record<string, JsonValue> | undefined]> = [];
  return {
    writes,
    readNamespaces: async () => structuredClone(initial),
    writeNamespace: async (extensionId, record) => {
      writes.push([extensionId, structuredClone(record)]);
    },
  };
}

describe("ExtensionProjectStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates on open, serves detached values, and rejects when closed", async () => {
    const io = createIo({
      "example.tags": { preferences: { theme: "dark" } },
    });
    const storage = new ExtensionProjectStorage(io, 50);
    expect(() => storage.get("example.tags", "preferences")).toThrow(
      /no project/,
    );

    await storage.openForProject();
    const value = storage.get("example.tags", "preferences");
    expect(value).toEqual({ theme: "dark" });
    expect(Object.isFrozen(value)).toBe(true);
    expect(storage.keys("example.tags")).toEqual(["preferences"]);

    await storage.closeProject();
    expect(storage.isOpen()).toBe(false);
    expect(() => storage.keys("example.tags")).toThrow(/no project/);
  });

  it("debounces namespace writes and coalesces rapid sets", async () => {
    const io = createIo();
    const storage = new ExtensionProjectStorage(io, 50);
    await storage.openForProject();

    storage.set("example.tags", "a", 1);
    storage.set("example.tags", "b", 2);
    expect(io.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(60);
    expect(io.writes).toEqual([["example.tags", { a: 1, b: 2 }]]);
  });

  it("flushes pending writes on project close", async () => {
    const io = createIo();
    const storage = new ExtensionProjectStorage(io, 5_000);
    await storage.openForProject();
    storage.set("example.tags", "a", 1);

    await storage.closeProject();
    expect(io.writes).toEqual([["example.tags", { a: 1 }]]);
  });

  it("deleting the last key removes the namespace from the document", async () => {
    const io = createIo({ "example.tags": { a: 1 } });
    const storage = new ExtensionProjectStorage(io, 50);
    await storage.openForProject();

    storage.delete("example.tags", "a");
    await vi.advanceTimersByTimeAsync(60);
    expect(io.writes).toEqual([["example.tags", undefined]]);
    expect(storage.keys("example.tags")).toEqual([]);
  });

  it("enforces the per-namespace budget without corrupting existing data", async () => {
    const io = createIo();
    const storage = new ExtensionProjectStorage(io, 50);
    await storage.openForProject();
    storage.set("example.tags", "small", "ok");

    const oversized = "x".repeat(EXTENSION_STORAGE_NAMESPACE_BUDGET_BYTES);
    expect(() => storage.set("example.tags", "big", oversized)).toThrow(
      /budget/,
    );
    expect(storage.get("example.tags", "small")).toBe("ok");
    expect(storage.keys("example.tags")).toEqual(["small"]);

    // The contract is measured in UTF-8 bytes, not JavaScript string length.
    const oversizedUnicode = "é".repeat(
      Math.floor(EXTENSION_STORAGE_NAMESPACE_BUDGET_BYTES / 2),
    );
    expect(() =>
      storage.set("example.tags", "unicode", oversizedUnicode),
    ).toThrow(/budget/);
  });

  it("waits for a promoted write before closing", async () => {
    let finishWrite: (() => void) | undefined;
    const writeNamespace = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const storage = new ExtensionProjectStorage(
      { readNamespaces: async () => ({}), writeNamespace },
      50,
    );
    await storage.openForProject();
    storage.set("example.tags", "a", 1);

    await vi.advanceTimersByTimeAsync(60);
    expect(writeNamespace).toHaveBeenCalledTimes(1);

    let closed = false;
    const closing = storage.closeProject().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishWrite?.();
    await closing;
    expect(closed).toBe(true);
  });

  it("keeps a failed namespace dirty and retries it during close", async () => {
    const persistenceError = new Error("disk unavailable");
    const writeNamespace = vi
      .fn<ExtensionProjectStorageIo["writeNamespace"]>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValue(undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const storage = new ExtensionProjectStorage(
      { readNamespaces: async () => ({}), writeNamespace },
      50,
    );
    await storage.openForProject();
    storage.set("example.tags", "a", 1);

    await vi.advanceTimersByTimeAsync(60);
    expect(writeNamespace).toHaveBeenCalledTimes(1);

    await storage.closeProject();
    expect(writeNamespace).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist project storage"),
      persistenceError,
    );
    consoleError.mockRestore();
  });

  it("validates keys and values", async () => {
    const storage = new ExtensionProjectStorage(createIo(), 50);
    await storage.openForProject();
    expect(() => storage.set("example.tags", "", 1)).toThrow(/1-128/);
    expect(() => storage.set("example.tags", "a/b", 1)).toThrow(/without/);
    expect(() =>
      storage.set("example.tags", "nan", Number.NaN as unknown as JsonValue),
    ).toThrow(/finite JSON/);
  });

  it("notifies only the owning extension's subscribers", async () => {
    const storage = new ExtensionProjectStorage(createIo(), 50);
    await storage.openForProject();
    const mine = vi.fn();
    const other = vi.fn();
    storage.subscribe("example.tags", mine);
    storage.subscribe("example.other", other);

    storage.set("example.tags", "a", 1);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
