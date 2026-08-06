// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../../../timeline/api", () => ({
  getTimelineClips: vi.fn(() => []),
  getTimelineDuration: vi.fn(() => 5000),
  getTimelineTracks: vi.fn(() => [{ id: "t1" }]),
  getTimelineTransitions: vi.fn(() => []),
}));
vi.mock("../../../userAssets", () => ({
  addLocalAsset: vi.fn(),
  getAssets: vi.fn(() => []),
}));
vi.mock("../../../masks/api", () => ({
  prepareBrushMasksForTimelineRender: vi.fn(async () => undefined),
}));
vi.mock("../../../timelineSelection", () => ({
  getClipsInSelection: vi.fn(() => []),
  resolveSelectionFps: vi.fn(() => 30),
}));
vi.mock("../../services/renderSelectionToVideoFile", () => ({
  renderSelectionToVideoFile: vi.fn(),
}));
vi.mock("../../utils/dimensions", () => ({
  deriveTrueDimensionsFromShortEdge: vi.fn(() => ({ width: 1280, height: 720 })),
}));
vi.mock("../../services/ExportRenderer", () => ({
  ExportRenderer: class {},
}));

import { addLocalAsset } from "../../../userAssets";
import { prepareBrushMasksForTimelineRender } from "../../../masks/api";
import { renderSelectionToVideoFile } from "../../services/renderSelectionToVideoFile";
import { deriveTrueDimensionsFromShortEdge } from "../../utils/dimensions";
import { useExportJobController } from "../useExportJobController";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import { getHostExportController } from "../../../../core/export/exportController";
import {
  getLatestExportRun,
  listExportRuns,
  resetExportRunLogForTests,
  subscribeExportRuns,
} from "../../../../core/export/exportRunLog";

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function makeController() {
  return renderHook(() =>
    useExportJobController({
      projectAspectRatio: "16:9",
      logicalDimensions: { width: 1920, height: 1080 },
      projectFps: 24,
    }),
  );
}

function selectionOptions() {
  return {
    selectionStartTick: 0,
    selectionEndTick: 1000,
    selectionMessage: "hi",
    selectionIncludedTrackIds: ["t1"],
    selectionFpsOverride: null,
    selectionFrameStep: 1,
  };
}

beforeEach(() => {
  vi.mocked(renderSelectionToVideoFile).mockReset();
  vi.mocked(addLocalAsset).mockReset();
  vi.mocked(prepareBrushMasksForTimelineRender).mockReset();
  vi.mocked(prepareBrushMasksForTimelineRender).mockResolvedValue(undefined);
  vi.mocked(deriveTrueDimensionsFromShortEdge).mockReset();
  vi.mocked(deriveTrueDimensionsFromShortEdge).mockReturnValue({
    width: 1280,
    height: 720,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetExportRunLogForTests();
  useExtractStore.setState({
    dialogOpen: false,
    dialogView: "choose",
    isProcessing: false,
    progress: 0,
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator as object, "wakeLock");
  vi.restoreAllMocks();
});

describe("useExportJobController runSelectionExport", () => {
  it("renders the selection and ingests the resulting file", async () => {
    const file = new File(["v"], "selection.mp4");
    vi.mocked(renderSelectionToVideoFile).mockResolvedValue(file);

    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    expect(renderSelectionToVideoFile).toHaveBeenCalledOnce();
    expect(prepareBrushMasksForTimelineRender).toHaveBeenCalledOnce();
    expect(
      vi.mocked(prepareBrushMasksForTimelineRender).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(renderSelectionToVideoFile).mock.invocationCallOrder[0],
    );
    const [selection, opts] = vi.mocked(renderSelectionToVideoFile).mock.calls[0];
    expect(selection).toMatchObject({ start: 0, end: 1000, message: "hi", fps: 30 });
    expect(opts!.renderInputs!.exportConfig).toMatchObject({
      logicalWidth: 1920,
      logicalHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    });
    expect(addLocalAsset).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ source: "extracted" }),
      undefined,
      { reuseExistingHash: true },
    );
  });

  it("logs non-abort failures and does not ingest", async () => {
    vi.mocked(renderSelectionToVideoFile).mockRejectedValue(new Error("boom"));

    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    expect(console.error).toHaveBeenCalledWith(
      "Selection extraction failed",
      expect.any(Error),
    );
    expect(addLocalAsset).not.toHaveBeenCalled();
  });

  it("does not snapshot or render when brush materialization fails", async () => {
    vi.mocked(prepareBrushMasksForTimelineRender).mockRejectedValue(
      new Error("brush changed"),
    );

    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    expect(renderSelectionToVideoFile).not.toHaveBeenCalled();
    expect(addLocalAsset).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Selection extraction failed",
      expect.any(Error),
    );
  });

  it("swallows abort errors silently", async () => {
    vi.mocked(renderSelectionToVideoFile).mockRejectedValue(abortError());

    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    expect(console.error).not.toHaveBeenCalled();
  });

  it("cancels the active renderer when cancel() is called mid-render", async () => {
    const renderer = { cancel: vi.fn() };
    let release!: () => void;
    vi.mocked(renderSelectionToVideoFile).mockImplementation(
      async (_selection, opts) => {
        opts?.onRendererCreated?.(renderer as never);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new File(["v"], "s.mp4");
      },
    );

    const { result } = makeController();
    let pending: Promise<void>;
    act(() => {
      pending = result.current.runSelectionExport(selectionOptions());
    });

    act(() => {
      result.current.cancel();
    });
    await waitFor(() => {
      expect(renderer.cancel).toHaveBeenCalled();
    });

    await act(async () => {
      release();
      await pending;
    });
  });
});

describe("useExportJobController run log", () => {
  it("records a completed selection extraction with the asset it produced", async () => {
    vi.mocked(renderSelectionToVideoFile).mockImplementation(
      async (_selection, opts) => {
        opts?.onProgress?.(50);
        return new File(["v"], "selection.mp4");
      },
    );
    vi.mocked(addLocalAsset).mockResolvedValue({ id: "asset-9" } as never);

    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    expect(getLatestExportRun()).toMatchObject({
      kind: "range",
      status: "completed",
      startTicks: 0,
      endTicks: 1000,
      progress: 1,
      assetId: "asset-9",
      error: null,
    });
  });

  it("reuses the existing asset when the render is byte-identical", async () => {
    vi.mocked(renderSelectionToVideoFile).mockResolvedValue(
      new File(["v"], "selection.mp4"),
    );
    vi.mocked(addLocalAsset).mockResolvedValue({ id: "asset-existing" } as never);

    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    expect(addLocalAsset).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ source: "extracted" }),
      undefined,
      { reuseExistingHash: true },
    );
    expect(getLatestExportRun()).toMatchObject({
      status: "completed",
      assetId: "asset-existing",
    });
  });

  it("fails rather than completing with nothing when ingest produces no asset", async () => {
    vi.mocked(renderSelectionToVideoFile).mockResolvedValue(
      new File(["v"], "selection.mp4"),
    );
    vi.mocked(addLocalAsset).mockResolvedValue(null);

    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    expect(getLatestExportRun()).toMatchObject({
      status: "failed",
      assetId: null,
      error: expect.stringContaining("library"),
    });
  });

  it("distinguishes a cancelled render from a failed one", async () => {
    vi.mocked(renderSelectionToVideoFile).mockRejectedValue(abortError());
    const { result } = makeController();
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });
    expect(getLatestExportRun()).toMatchObject({
      status: "cancelled",
      error: null,
    });

    vi.mocked(renderSelectionToVideoFile).mockRejectedValue(new Error("boom"));
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });
    expect(getLatestExportRun()).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });
});

describe("useExportJobController export registry", () => {
  it("renders a registry range request and shows it to the user", async () => {
    vi.mocked(renderSelectionToVideoFile).mockResolvedValue(
      new File(["v"], "range.mp4"),
    );
    vi.mocked(addLocalAsset).mockResolvedValue({ id: "asset-ext" } as never);

    makeController();
    const controller = getHostExportController();
    expect(controller?.canStart()).toBe(true);

    let runId = "";
    await act(async () => {
      runId = controller!.startRange({
        startTicks: 0,
        endTicks: 500,
        formatId: "webm",
        format: "webm",
        frameStep: 2,
        trackIds: ["t1"],
        startedByExtension: "example.export-report",
      });
      // The dialog opens synchronously with the run: a render that held the
      // editor with nothing on screen would look like a hang.
      expect(useExtractStore.getState()).toMatchObject({
        dialogOpen: true,
        dialogView: "extracting-selection",
        isProcessing: true,
      });
      expect(controller!.canStart()).toBe(false);
    });

    const [, opts] = vi.mocked(renderSelectionToVideoFile).mock.calls[0];
    expect(opts!.format).toBe("webm");
    expect(listExportRuns()[0]).toMatchObject({
      id: runId,
      kind: "range",
      status: "completed",
      formatId: "webm",
      startedByExtension: "example.export-report",
      assetId: "asset-ext",
    });
    expect(useExtractStore.getState().dialogOpen).toBe(false);
  });

  it("frees the renderer before announcing that the run settled", async () => {
    vi.mocked(renderSelectionToVideoFile).mockResolvedValue(
      new File(["v"], "range.mp4"),
    );
    vi.mocked(addLocalAsset).mockResolvedValue({ id: "asset-ext" } as never);

    makeController();
    const controller = getHostExportController()!;

    // What an extension does from its completion notification: start the next
    // render. It must not be refused by state the host has not released.
    const canStartWhenSettled: boolean[] = [];
    const unsubscribe = subscribeExportRuns(() => {
      const run = getLatestExportRun();
      if (run && run.status !== "running") {
        canStartWhenSettled.push(controller.canStart());
      }
    });

    await act(async () => {
      controller.startRange({
        startTicks: 0,
        endTicks: 500,
        formatId: "mp4",
        format: "mp4",
        startedByExtension: "example.export-report",
      });
    });

    expect(canStartWhenSettled).toEqual([true]);
    unsubscribe();
  });

  it("fails the run rather than rendering an unsupported container", async () => {
    makeController();
    const controller = getHostExportController();

    const runId = controller!.startRange({
      startTicks: 0,
      endTicks: 500,
      formatId: "gif",
      format: "gif",
    });

    expect(renderSelectionToVideoFile).not.toHaveBeenCalled();
    expect(listExportRuns()[0]).toMatchObject({
      id: runId,
      status: "failed",
      error: expect.stringContaining("gif"),
    });
  });
});

describe("useExportJobController session guard", () => {
  it("aborts a renderer registered against a stale session", async () => {
    const staleRenderer = { cancel: vi.fn() };
    const capturedOptions: Array<{
      onRendererCreated?: (r: unknown) => void;
    }> = [];

    vi.mocked(renderSelectionToVideoFile).mockImplementation(
      async (_selection, opts) => {
        capturedOptions.push(opts as never);
        return new File(["v"], "s.mp4");
      },
    );

    const { result } = makeController();

    // First run captures its options without yet registering a renderer.
    let firstPending: Promise<void>;
    await act(async () => {
      firstPending = result.current.runSelectionExport(selectionOptions());
      await firstPending;
    });

    // A second run bumps the session id.
    await act(async () => {
      await result.current.runSelectionExport(selectionOptions());
    });

    // Now replay the first run's renderer registration: it belongs to the
    // stale session, so it must be cancelled and the abort swallowed.
    expect(() =>
      capturedOptions[0].onRendererCreated?.(staleRenderer),
    ).toThrow(/cancelled/);
    expect(staleRenderer.cancel).toHaveBeenCalled();
  });
});

describe("useExportJobController runProjectExport", () => {
  it("renders the full timeline with even output dimensions", async () => {
    vi.mocked(renderSelectionToVideoFile).mockResolvedValue(
      new File(["v"], "export.mp4"),
    );

    const { result } = makeController();
    await act(async () => {
      await result.current.runProjectExport({
        resolution: 720,
        format: "webm",
        keyFrameInterval: 2,
      });
    });

    expect(deriveTrueDimensionsFromShortEdge).toHaveBeenCalledWith("16:9", 720);
    expect(prepareBrushMasksForTimelineRender).toHaveBeenCalledOnce();
    const [selection, opts] = vi.mocked(renderSelectionToVideoFile).mock.calls[0];
    expect(selection).toMatchObject({ start: 0, end: 5000, fps: 24 });
    expect(opts!.filenamePrefix).toBe("export");
    expect(opts!.format).toBe("webm");
    expect(opts!.keyFrameInterval).toBe(2);
    expect(opts!.renderInputs!.exportConfig).toMatchObject({
      outputWidth: 1280,
      outputHeight: 720,
    });
    // project export never ingests an asset
    expect(addLocalAsset).not.toHaveBeenCalled();
  });

  it("logs non-abort project export failures", async () => {
    vi.mocked(renderSelectionToVideoFile).mockRejectedValue(new Error("nope"));

    const { result } = makeController();
    await act(async () => {
      await result.current.runProjectExport({ resolution: 1080 });
    });

    expect(console.error).toHaveBeenCalledWith("Export failed", expect.any(Error));
  });

  it("records the run so it outlives the dialog that showed it", async () => {
    vi.mocked(renderSelectionToVideoFile).mockImplementation(
      async (_selection, opts) => {
        opts?.onProgress?.(40);
        return new File(["v"], "export.mp4");
      },
    );

    const { result } = makeController();
    await act(async () => {
      await result.current.runProjectExport({ resolution: 1080 });
    });

    expect(getLatestExportRun()).toMatchObject({
      kind: "project",
      status: "completed",
      startTicks: 0,
      endTicks: 5000,
      progress: 1,
      // A project export writes to the user's file, so it has no asset.
      assetId: null,
      startedByExtension: null,
    });
  });

  it("releases a late wake-lock grant when export setup fails", async () => {
    const sentinel = {
      released: false,
      release: vi.fn(async () => {
        sentinel.released = true;
      }),
    };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: vi.fn(async () => sentinel),
      },
    });
    vi.mocked(deriveTrueDimensionsFromShortEdge).mockImplementationOnce(() => {
      throw new Error("invalid dimensions");
    });

    const { result } = makeController();
    await act(async () => {
      await result.current.runProjectExport({ resolution: 1080 });
    });
    await Promise.resolve();

    expect(sentinel.release).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("Export failed", expect.any(Error));
  });
});
