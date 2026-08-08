import { describe, expect, it, vi } from "vitest";
import {
  createLocalShellLayoutPersistence,
  createMemoryShellLayoutPersistence,
  type ShellLayoutStorage,
} from "../layoutPersistence";
import {
  LEGACY_VIEW_LAYOUT_STORAGE_KEY,
  SHELL_LAYOUT_STORAGE_KEY,
} from "../layoutMigrations";
import { EMPTY_SHELL_LAYOUT_DOCUMENT } from "../layoutTypes";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  } satisfies ShellLayoutStorage & { values: Map<string, string> };
}

describe("createLocalShellLayoutPersistence", () => {
  it("reads the current document when one exists", () => {
    const storage = createStorage({
      [SHELL_LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 2,
        panels: { "host.a": { visible: false } },
        regions: { "bottom-dock": { sizePx: 300 } },
        workspaceLayouts: {},
      }),
    });

    expect(createLocalShellLayoutPersistence(storage).read()).toEqual({
      version: 2,
      panels: { "host.a": { visible: false } },
      regions: { "bottom-dock": { sizePx: 300 } },
      workspaceLayouts: {},
    });
  });

  it("migrates the legacy view layout when no current document exists", () => {
    const storage = createStorage({
      [LEGACY_VIEW_LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 1,
        hidden: ["host.a"],
        order: { "left-sidebar": ["host.b", "host.a"] },
      }),
    });

    expect(createLocalShellLayoutPersistence(storage).read().panels).toEqual({
      "host.a": { visible: false, order: 1 },
      "host.b": { order: 0 },
    });
  });

  it("never writes over or removes the legacy key", () => {
    const legacy = JSON.stringify({ version: 1, hidden: ["host.a"], order: {} });
    const storage = createStorage({ [LEGACY_VIEW_LAYOUT_STORAGE_KEY]: legacy });
    const persistence = createLocalShellLayoutPersistence(storage);

    persistence.write({
      version: 2,
      panels: {},
      regions: {},
      workspaceLayouts: {},
    });

    expect(storage.values.get(LEGACY_VIEW_LAYOUT_STORAGE_KEY)).toBe(legacy);
    expect(storage.setItem).toHaveBeenCalledWith(
      SHELL_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        panels: {},
        regions: {},
        workspaceLayouts: {},
      }),
    );
  });

  it("degrades to no preference for corrupt, empty, or absent storage", () => {
    for (const raw of ["", "not json", "null", "[]", '{"version":9}']) {
      const storage = createStorage({ [SHELL_LAYOUT_STORAGE_KEY]: raw });
      expect(createLocalShellLayoutPersistence(storage).read()).toEqual(
        EMPTY_SHELL_LAYOUT_DOCUMENT,
      );
    }
    expect(createLocalShellLayoutPersistence(null).read()).toEqual(
      EMPTY_SHELL_LAYOUT_DOCUMENT,
    );
  });

  it("survives storage that throws on read and on write", () => {
    const storage: ShellLayoutStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const persistence = createLocalShellLayoutPersistence(storage);

    expect(persistence.read()).toEqual(EMPTY_SHELL_LAYOUT_DOCUMENT);
    expect(() =>
      persistence.write(EMPTY_SHELL_LAYOUT_DOCUMENT),
    ).not.toThrow();
  });

  it("falls back to the legacy key when the current document is corrupt", () => {
    const storage = createStorage({
      [SHELL_LAYOUT_STORAGE_KEY]: "{oops",
      [LEGACY_VIEW_LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 1,
        hidden: ["host.a"],
        order: {},
      }),
    });

    expect(createLocalShellLayoutPersistence(storage).read().panels).toEqual({
      "host.a": { visible: false },
    });
  });
});

describe("createMemoryShellLayoutPersistence", () => {
  it("round-trips the last written document", () => {
    const persistence = createMemoryShellLayoutPersistence();
    expect(persistence.read()).toEqual(EMPTY_SHELL_LAYOUT_DOCUMENT);

    const next = {
      version: 2,
      panels: { "host.a": { order: 1 } },
      regions: {},
      workspaceLayouts: {},
    } as const;
    persistence.write(next);

    expect(persistence.read()).toBe(next);
    expect(persistence.current).toBe(next);
    expect(persistence.writeCount).toBe(1);
  });
});
