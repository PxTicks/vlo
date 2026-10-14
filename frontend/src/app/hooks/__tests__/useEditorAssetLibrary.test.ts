import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { restoreCompositeEditSession } = vi.hoisted(() => ({
  restoreCompositeEditSession: vi.fn(),
}));

vi.mock("../../../features/composite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../features/composite")>()),
  restoreCompositeEditSession,
}));

import { useProjectStore } from "../../../features/project";
import { useCompositeLibraryStore } from "../../../features/composite";
import { useAssetStore } from "../../../features/userAssets";
import { useEditorAssetLibrary } from "../useEditorAssetLibrary";

const fetchAssets = vi.fn(async (): Promise<void> => undefined);
const fetchComposites = vi.fn(async (): Promise<void> => undefined);
const scanForNewAssets = vi.fn(async (): Promise<void> => undefined);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets every already-queued continuation run. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function openProject(rootAssetsFolder: string | null = "footage") {
  useProjectStore.setState({
    project: {
      id: "project-1",
      title: "Project",
      rootAssetsFolder,
      createdAt: 1,
      lastModified: 1,
    },
  });
}

describe("useEditorAssetLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreCompositeEditSession.mockImplementation(async () => undefined);
    useAssetStore.setState({ fetchAssets, scanForNewAssets });
    useCompositeLibraryStore.setState({ fetchComposites });
  });

  afterEach(() => {
    useProjectStore.setState({ project: null });
    vi.restoreAllMocks();
  });

  it("waits for each load to finish before starting the next", async () => {
    const assets = deferred();
    const composites = deferred();
    const session = deferred();
    fetchAssets.mockReturnValueOnce(assets.promise);
    fetchComposites.mockReturnValueOnce(composites.promise);
    restoreCompositeEditSession.mockReturnValueOnce(session.promise);
    openProject();
    renderHook(() => useEditorAssetLibrary());

    // Each stage stays unstarted while the one before it is still pending,
    // however many turns of the event loop pass.
    await settle();
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    expect(fetchComposites).not.toHaveBeenCalled();

    assets.resolve();
    await waitFor(() => expect(fetchComposites).toHaveBeenCalledTimes(1));
    await settle();
    expect(restoreCompositeEditSession).not.toHaveBeenCalled();

    composites.resolve();
    await waitFor(() =>
      expect(restoreCompositeEditSession).toHaveBeenCalledTimes(1),
    );
    await settle();
    expect(scanForNewAssets).not.toHaveBeenCalled();

    session.resolve();
    await waitFor(() => expect(scanForNewAssets).toHaveBeenCalledTimes(1));
  });

  it("does nothing until a project with an assets folder is open", async () => {
    renderHook(() => useEditorAssetLibrary());
    openProject(null);
    await Promise.resolve();
    expect(fetchAssets).not.toHaveBeenCalled();
  });

  it.each([
    ["the asset index", fetchAssets],
    ["the composite library", fetchComposites],
    ["the subtimeline session", restoreCompositeEditSession],
  ])("skips the disk scan when %s fails to load", async (_label, step) => {
    // Scanning against a stale store would re-ingest existing files under new
    // ids and duplicate them in assets.json.
    step.mockRejectedValueOnce(new Error("unreadable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openProject();
    renderHook(() => useEditorAssetLibrary());

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "[AssetLibrary] Skipping disk scan because asset index load failed",
        expect.any(Error),
      ),
    );
    expect(scanForNewAssets).not.toHaveBeenCalled();
  });
});
