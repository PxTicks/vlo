import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import {
  createExtensionProjectApi,
  EXTENSION_PRE_SAVE_HOOK_TIMEOUT_MS,
} from "../createExtensionProjectApi";
import {
  notifyProjectSaved,
  runProjectClosingHooks,
} from "../../../../core/project/projectLifecycleHooks";
import { runPreSaveHooks } from "../../../../core/persistence/preSaveHooks";
import {
  projectPersistenceService,
  useProjectStore,
} from "../../../project";
import { extensionProjectStorage } from "../../storage/installExtensionProjectStorage";

function createScope(
  report: ExtensionApiScope["report"] = vi.fn(),
): { scope: ExtensionApiScope; resources: ExtensionResource[] } {
  const resources: ExtensionResource[] = [];
  return {
    resources,
    scope: {
      extension: { id: "example.project", version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report,
    },
  };
}

function openProject(id: string, title = "Fixture") {
  useProjectStore.setState({
    project: {
      id,
      title,
      rootAssetsFolder: "assets",
      createdAt: 10,
      lastModified: 20,
    },
    rootHandle: {} as FileSystemDirectoryHandle,
  });
}

describe("createExtensionProjectApi", () => {
  afterEach(() => {
    useProjectStore.setState({ project: null, rootHandle: null });
  });

  it("reports no project until both the record and its handle are present", () => {
    const { scope } = createScope();
    const api = createExtensionProjectApi(scope);

    useProjectStore.setState({ project: null, rootHandle: null });
    expect(api.get()).toBeNull();

    // The store persists the project record to localStorage, so the projects
    // page can hold one with no directory handle. That is not an open project.
    useProjectStore.setState({
      project: {
        id: "project-1",
        title: "Fixture",
        rootAssetsFolder: "assets",
        createdAt: 10,
        lastModified: 20,
      },
      rootHandle: null,
    });
    expect(api.get()).toBeNull();

    openProject("project-1");
    expect(api.get()).toMatchObject({
      id: "project-1",
      title: "Fixture",
      createdAt: 10,
      lastModified: 20,
    });
  });

  it("signals identity changes and saves through one revision", () => {
    const { scope } = createScope();
    const api = createExtensionProjectApi(scope);
    openProject("project-1");
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    const initial = api.getRevision();

    useProjectStore.setState((state) => ({
      project: state.project ? { ...state.project, title: "Renamed" } : null,
    }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBeGreaterThan(initial);
    expect(api.get()?.title).toBe("Renamed");

    const afterRename = api.getRevision();
    notifyProjectSaved("project-1");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(api.getRevision()).toBeGreaterThan(afterRename);
    expect(api.get()?.lastSavedAt).toEqual(expect.any(Number));

    unsubscribe();
    notifyProjectSaved("project-1");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not attribute another project's save to the open one", () => {
    const { scope } = createScope();
    const api = createExtensionProjectApi(scope);

    openProject("project-1");
    notifyProjectSaved("project-1");
    expect(api.get()?.lastSavedAt).toEqual(expect.any(Number));

    openProject("project-2");
    expect(api.get()?.lastSavedAt).toBeNull();
  });

  it("does not carry a save across reopening the same project", async () => {
    const { scope } = createScope();
    const api = createExtensionProjectApi(scope);

    openProject("project-1");
    notifyProjectSaved("project-1");
    expect(api.get()?.lastSavedAt).toEqual(expect.any(Number));

    // Reopening the same project is a new session. The ID alone cannot tell
    // the two apart, so the record is cleared as the project goes away.
    await runProjectClosingHooks();
    useProjectStore.setState({ project: null, rootHandle: null });
    openProject("project-1");
    expect(api.get()?.lastSavedAt).toBeNull();
  });

  it("signals again when project storage finishes hydrating", async () => {
    const { scope } = createScope();
    const api = createExtensionProjectApi(scope);
    openProject("project-1");
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    const beforeHydration = api.getRevision();

    // Storage hydrates asynchronously, so a project is open before its
    // document lands. Without this signal an extension that read a null
    // `storage.project` on open would never be told it became available.
    const read = vi
      .spyOn(projectPersistenceService, "readExtensionStorage")
      .mockResolvedValue({
        documentType: "vlo.extension-storage",
        schemaVersion: 1,
        updated_at: 0,
        storage: {},
      });
    await extensionProjectStorage.openForProject();
    expect(listener).toHaveBeenCalled();
    expect(api.getRevision()).toBeGreaterThan(beforeHydration);

    const afterHydration = api.getRevision();
    await extensionProjectStorage.closeProject();
    expect(api.getRevision()).toBeGreaterThan(afterHydration);
    unsubscribe();
    read.mockRestore();
  });

  it("runs pre-save hooks and removes them on disposal", async () => {
    const { scope, resources } = createScope();
    const api = createExtensionProjectApi(scope);
    const hook = vi.fn();

    const remove = api.onBeforeSave(hook);
    await runPreSaveHooks();
    expect(hook).toHaveBeenCalledTimes(1);

    remove();
    await runPreSaveHooks();
    expect(hook).toHaveBeenCalledTimes(1);

    // Deactivation disposes it too, without needing the returned remover.
    api.onBeforeSave(hook);
    for (const resource of resources) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await runPreSaveHooks();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("reports a throwing hook as advisory and still completes the save", async () => {
    const report = vi.fn();
    const { scope } = createScope(report);
    const api = createExtensionProjectApi(scope);
    const later = vi.fn();

    const removeFirst = api.onBeforeSave(() => {
      throw new Error("hook boom");
    });
    const removeSecond = api.onBeforeSave(later);

    await expect(runPreSaveHooks()).resolves.toBe(2);
    expect(report).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("Pre-save hook failed"),
      expect.any(Error),
    );
    expect(later).toHaveBeenCalledTimes(1);

    removeFirst();
    removeSecond();
  });

  it("abandons a hook that outlives the host's budget", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const { scope } = createScope(report);
    const api = createExtensionProjectApi(scope);
    const remove = api.onBeforeSave(() => new Promise<void>(() => undefined));

    const saved = runPreSaveHooks();
    await vi.advanceTimersByTimeAsync(EXTENSION_PRE_SAVE_HOOK_TIMEOUT_MS + 1);
    await expect(saved).resolves.toBe(1);
    expect(report).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("Pre-save hook failed"),
      expect.any(Error),
    );

    remove();
    vi.useRealTimers();
  });
});
