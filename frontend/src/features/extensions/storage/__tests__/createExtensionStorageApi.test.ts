import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { createExtensionStorageApi } from "../createExtensionStorageApi";
import { extensionProjectStorage } from "../installExtensionProjectStorage";

const clientMocks = vi.hoisted(() => ({
  listLocalStorageKeys: vi.fn(async () => ["a"]),
  getLocalStorageValue: vi.fn(async () => "stored"),
  setLocalStorageValue: vi.fn(async () => undefined),
  deleteLocalStorageValue: vi.fn(async () => undefined),
}));

vi.mock("../localStorageClient", () => clientMocks);

// The singleton's IO hits project persistence; neutralize it for unit tests.
vi.mock("../../../project/services/ProjectPersistenceService", () => ({
  projectPersistenceService: {
    readExtensionStorage: async () => ({
      documentType: "vlo.extension-storage",
      schemaVersion: 1,
      updated_at: 0,
      storage: { "example.other": { retained: true } },
    }),
    updateExtensionStorageNamespace: async () => undefined,
  },
}));

function createScope(
  extensionId: string,
  report: ExtensionApiScope["report"] = vi.fn(),
): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

describe("createExtensionStorageApi", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    if (extensionProjectStorage.isOpen()) {
      await extensionProjectStorage.closeProject();
    }
  });

  it("routes the local scope through the backend client with validation and notification", async () => {
    const api = createExtensionStorageApi(createScope("example.tags"));
    const listener = vi.fn();
    api.local.subscribe(listener);

    await expect(api.local.get("theme")).resolves.toBe("stored");
    expect(clientMocks.getLocalStorageValue).toHaveBeenCalledWith(
      "example.tags",
      "theme",
    );

    await api.local.set("theme", "dark");
    expect(clientMocks.setLocalStorageValue).toHaveBeenCalledWith(
      "example.tags",
      "theme",
      "dark",
    );
    expect(listener).toHaveBeenCalledTimes(1);

    await api.local.delete("theme");
    expect(listener).toHaveBeenCalledTimes(2);
    await expect(api.local.keys()).resolves.toEqual(["a"]);

    await expect(api.local.set("bad/key", 1)).rejects.toThrow(/without/);
    await expect(
      api.local.set("nan", Number.NaN as unknown as never),
    ).rejects.toThrow(/finite JSON/);
  });

  it("exposes project storage only while a project is open", async () => {
    const api = createExtensionStorageApi(createScope("example.tags"));
    expect(api.project).toBeNull();

    await extensionProjectStorage.openForProject();
    const project = api.project;
    expect(project).not.toBeNull();

    await project?.set("count", 2);
    await expect(project?.get("count")).resolves.toBe(2);
    await expect(project?.keys()).resolves.toEqual(["count"]);

    await extensionProjectStorage.closeProject();
    expect(api.project).toBeNull();
  });

  it("keeps other extensions' namespaces retained and invisible", async () => {
    await extensionProjectStorage.openForProject();
    const api = createExtensionStorageApi(createScope("example.tags"));
    await expect(api.project?.keys()).resolves.toEqual([]);
    // The unrelated namespace loaded from disk stays in the projection for
    // round-tripping even though this owner cannot see it.
    expect(extensionProjectStorage.keys("example.other")).toEqual([
      "retained",
    ]);
    await extensionProjectStorage.closeProject();
  });

  it("isolates project-scope subscriber failures with an owner diagnostic", async () => {
    const report = vi.fn();
    await extensionProjectStorage.openForProject();
    const api = createExtensionStorageApi(createScope("example.tags", report));
    api.project?.subscribe(() => {
      throw new Error("subscriber boom");
    });

    await api.project?.set("a", 1);
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Project storage subscriber failed"),
      expect.any(Error),
    );
    await extensionProjectStorage.closeProject();
  });
});
