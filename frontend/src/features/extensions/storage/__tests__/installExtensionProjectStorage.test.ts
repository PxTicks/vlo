import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectClosingHook } from "../../../../core/project/projectLifecycleHooks";
import { useProjectStore } from "../../../project";
import type { JsonValue } from "../../types";
import { ExtensionProjectStorage } from "../ExtensionProjectStorage";
import { installExtensionProjectStorage } from "../installExtensionProjectStorage";

function projectState(id: string) {
  return {
    project: { id } as never,
    rootHandle: {} as FileSystemDirectoryHandle,
  };
}

describe("installExtensionProjectStorage", () => {
  afterEach(() => {
    useProjectStore.setState({ project: null, rootHandle: null });
  });

  it("flushes the old namespace before an open-over-open handle switch", async () => {
    let activeProjectId = "project-a";
    const documents = new Map<
      string,
      Record<string, Record<string, JsonValue>>
    >([
      ["project-a", {}],
      ["project-b", {}],
    ]);
    const writeTargets: string[] = [];
    const storage = new ExtensionProjectStorage(
      {
        readNamespaces: async () =>
          structuredClone(documents.get(activeProjectId) ?? {}),
        writeNamespace: async (extensionId, record) => {
          writeTargets.push(activeProjectId);
          const document = documents.get(activeProjectId) ?? {};
          if (record === undefined) delete document[extensionId];
          else document[extensionId] = structuredClone(record);
          documents.set(activeProjectId, document);
        },
      },
      5_000,
    );
    let closingHook: ProjectClosingHook | undefined;
    useProjectStore.setState(projectState("project-a"));
    const registration = installExtensionProjectStorage(storage, (hook) => {
      closingHook = hook;
      return () => {
        closingHook = undefined;
      };
    });

    await vi.waitFor(() => expect(storage.isOpen()).toBe(true));
    storage.set("example.tags", "tags", ["outdoor"]);

    await closingHook?.();
    expect(storage.isOpen()).toBe(false);
    expect(writeTargets).toEqual(["project-a"]);

    activeProjectId = "project-b";
    useProjectStore.setState(projectState("project-b"));
    await vi.waitFor(() => expect(storage.isOpen()).toBe(true));
    expect(storage.keys("example.tags")).toEqual([]);
    expect(documents.get("project-a")).toEqual({
      "example.tags": { tags: ["outdoor"] },
    });
    expect(documents.get("project-b")).toEqual({});

    await registration.dispose();
  });
});
