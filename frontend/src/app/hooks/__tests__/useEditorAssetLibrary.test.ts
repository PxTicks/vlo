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

const calls: string[] = [];
const fetchAssets = vi.fn(async () => {
  calls.push("assets");
});
const fetchComposites = vi.fn(async () => {
  calls.push("composites");
});
const scanForNewAssets = vi.fn(async () => {
  calls.push("scan");
});

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
    calls.length = 0;
    vi.clearAllMocks();
    restoreCompositeEditSession.mockImplementation(async () => {
      calls.push("session");
    });
    useAssetStore.setState({ fetchAssets, scanForNewAssets });
    useCompositeLibraryStore.setState({ fetchComposites });
  });

  afterEach(() => {
    useProjectStore.setState({ project: null });
    vi.restoreAllMocks();
  });

  it("loads assets, then composites, then the open subtimeline, then scans", async () => {
    openProject();
    renderHook(() => useEditorAssetLibrary());

    await waitFor(() => expect(scanForNewAssets).toHaveBeenCalled());
    expect(calls).toEqual(["assets", "composites", "session", "scan"]);
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
