import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaSecondsToTick } from "../../../core/time";
import { resetZustandStore } from "../../../testUtils/zustand";
import type { ResolvedEditorSource } from "../types";
import { useMiniEditorStore } from "../useMiniEditorStore";

function source(
  sourceUrl = "blob:source",
  durationTicks = mediaSecondsToTick(10),
): ResolvedEditorSource {
  return {
    sourceUrl,
    sourceFile: new File(["video"], "source.mp4", { type: "video/mp4" }),
    durationTicks,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useMiniEditorStore", () => {
  beforeEach(() => {
    resetZustandStore(useMiniEditorStore);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    useMiniEditorStore.getState().close();
    vi.restoreAllMocks();
  });

  it("prepares a source, applies initial state, and clamps crop bounds", async () => {
    const prepared = source();
    const onSave = vi.fn();

    await useMiniEditorStore.getState().open({
      title: "Trim result",
      prepare: vi.fn(async () => prepared),
      onSave,
      initial: {
        cropStartTicks: -100,
        cropEndTicks: prepared.durationTicks + 100,
        ranges: [
          {
            id: "range-1",
            startSourceTicks: 10,
            endSourceTicks: 20,
            isActive: true,
          },
        ],
      },
    });

    expect(useMiniEditorStore.getState()).toMatchObject({
      isOpen: true,
      title: "Trim result",
      status: "ready",
      source: prepared,
      cropStartTicks: 0,
      cropEndTicks: prepared.durationTicks,
      playheadTicks: 0,
      selectedRangeId: null,
    });
  });

  it("reports preparation errors without discarding the open dialog", async () => {
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => {
        throw new Error("decode failed");
      }),
      onSave: vi.fn(),
    });

    expect(useMiniEditorStore.getState()).toMatchObject({
      isOpen: true,
      status: "error",
      error: "decode failed",
      source: null,
    });
  });

  it("ignores and revokes a stale preparation result", async () => {
    const first = deferred<ResolvedEditorSource>();
    const secondSource = source("blob:second");
    const firstOpen = useMiniEditorStore.getState().open({
      prepare: () => first.promise,
      onSave: vi.fn(),
    });
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => secondSource),
      onSave: vi.fn(),
    });

    const staleSource = source("blob:stale");
    first.resolve(staleSource);
    await firstOpen;

    expect(useMiniEditorStore.getState().source).toBe(secondSource);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:stale");
  });

  it("closing while preparation is pending prevents stale errors", async () => {
    const pending = deferred<ResolvedEditorSource>();
    const opening = useMiniEditorStore.getState().open({
      prepare: () => pending.promise,
      onSave: vi.fn(),
    });

    useMiniEditorStore.getState().close();
    pending.reject(new Error("late failure"));
    await opening;

    expect(useMiniEditorStore.getState()).toMatchObject({
      isOpen: false,
      status: "preparing",
      error: null,
    });
  });

  it("clamps crop and playhead values to the source duration", async () => {
    const prepared = source();
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onSave: vi.fn(),
    });
    useMiniEditorStore.getState().setPlayhead(prepared.durationTicks);
    useMiniEditorStore
      .getState()
      .setCrop(mediaSecondsToTick(2), mediaSecondsToTick(4));

    expect(useMiniEditorStore.getState()).toMatchObject({
      cropStartTicks: mediaSecondsToTick(2),
      cropEndTicks: mediaSecondsToTick(4),
      playheadTicks: mediaSecondsToTick(4),
    });

    useMiniEditorStore.getState().setPlayhead(-1);
    expect(useMiniEditorStore.getState().playheadTicks).toBe(0);
  });

  it("snaps crop length to the configured frame step from either anchor", async () => {
    const prepared = source("blob:source", mediaSecondsToTick(2));
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onSave: vi.fn(),
      frameConstraint: { fps: 10, frameStep: 4 },
    });

    useMiniEditorStore
      .getState()
      .setCrop(0, mediaSecondsToTick(0.63));
    expect(useMiniEditorStore.getState().cropEndTicks).toBe(
      mediaSecondsToTick(0.5),
    );

    useMiniEditorStore
      .getState()
      .setCrop(mediaSecondsToTick(1.4), mediaSecondsToTick(2));
    expect(useMiniEditorStore.getState().cropStartTicks).toBe(
      mediaSecondsToTick(1.5),
    );
  });

  it("snaps crop length to a workflow offset grid", async () => {
    // 10 fps with a 4k+5 grid: valid crop lengths are 0.5s, 0.9s, 1.3s, ...
    const prepared = source("blob:source", mediaSecondsToTick(2));
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onSave: vi.fn(),
      frameConstraint: { fps: 10, frameStep: 4, frameOffset: 5 },
    });

    useMiniEditorStore.getState().setCrop(0, mediaSecondsToTick(1));
    expect(useMiniEditorStore.getState().cropEndTicks).toBe(
      mediaSecondsToTick(0.9),
    );

    useMiniEditorStore
      .getState()
      .setCrop(mediaSecondsToTick(1.4), mediaSecondsToTick(2));
    expect(useMiniEditorStore.getState().cropStartTicks).toBe(
      mediaSecondsToTick(1.5),
    );
  });

  it("leaves the crop alone when no grid-valid span fits the source", async () => {
    // Three frames of source against a grid whose shortest span is five.
    const prepared = source("blob:source", mediaSecondsToTick(0.3));
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onSave: vi.fn(),
      frameConstraint: { fps: 10, frameStep: 4, frameOffset: 5 },
    });

    const before = useMiniEditorStore.getState();
    useMiniEditorStore.getState().setCrop(0, mediaSecondsToTick(0.2));

    expect(useMiniEditorStore.getState().cropStartTicks).toBe(
      before.cropStartTicks,
    );
    expect(useMiniEditorStore.getState().cropEndTicks).toBe(before.cropEndTicks);
  });

  it("manages range masks within crop and duration bounds", async () => {
    const prepared = source("blob:source", mediaSecondsToTick(5));
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onSave: vi.fn(),
      initial: {
        cropStartTicks: mediaSecondsToTick(1),
        cropEndTicks: mediaSecondsToTick(3),
      },
    });
    useMiniEditorStore.getState().setPlayhead(mediaSecondsToTick(2.5));
    useMiniEditorStore.getState().addRangeAtPlayhead();

    const [range] = useMiniEditorStore.getState().ranges;
    expect(range).toMatchObject({
      startSourceTicks: mediaSecondsToTick(2.5),
      endSourceTicks: mediaSecondsToTick(3),
      isActive: true,
    });
    expect(useMiniEditorStore.getState().selectedRangeId).toBe(range.id);

    useMiniEditorStore
      .getState()
      .updateRange(range.id, -100, prepared.durationTicks + 100);
    expect(useMiniEditorStore.getState().ranges[0]).toMatchObject({
      startSourceTicks: 0,
      endSourceTicks: prepared.durationTicks,
    });

    useMiniEditorStore.getState().toggleRange(range.id);
    expect(useMiniEditorStore.getState().ranges[0].isActive).toBe(false);
    useMiniEditorStore.getState().selectRange(null);
    expect(useMiniEditorStore.getState().selectedRangeId).toBeNull();
    useMiniEditorStore.getState().selectRange(range.id);
    useMiniEditorStore.getState().removeRange(range.id);
    expect(useMiniEditorStore.getState().ranges).toEqual([]);
    expect(useMiniEditorStore.getState().selectedRangeId).toBeNull();
  });

  it("updates valid source dimensions and playback state", async () => {
    useMiniEditorStore.getState().setSourceDimensions(0, 100);
    expect(useMiniEditorStore.getState().sourceWidth).toBe(0);
    useMiniEditorStore.getState().setSourceDimensions(1920, 1080);
    useMiniEditorStore.getState().setPlaying(true);
    expect(useMiniEditorStore.getState()).toMatchObject({
      sourceWidth: 1920,
      sourceHeight: 1080,
      isPlaying: true,
    });
  });

  it("saves the edit, revokes the URL, and closes", async () => {
    const prepared = source();
    const onSave = vi.fn(async () => undefined);
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onSave,
    });

    await useMiniEditorStore.getState().save();

    expect(onSave).toHaveBeenCalledWith(
      {
        cropStartTicks: 0,
        cropEndTicks: prepared.durationTicks,
        ranges: [],
      },
      prepared,
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(prepared.sourceUrl);
    expect(useMiniEditorStore.getState().isOpen).toBe(false);
  });

  it("keeps the editor open and reports save failures", async () => {
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => source()),
      onSave: vi.fn(async () => {
        throw "save failed";
      }),
    });

    await useMiniEditorStore.getState().save();

    expect(useMiniEditorStore.getState()).toMatchObject({
      isOpen: true,
      status: "error",
      error: "Failed to save the edit",
      isPlaying: false,
    });
  });

  it("does not save without a prepared source", async () => {
    const onSave = vi.fn();
    useMiniEditorStore.setState({
      status: "saving",
      _internal: {
        ...useMiniEditorStore.getState()._internal,
        onSave,
      },
    });
    await useMiniEditorStore.getState().save();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("runs viewer extractions and keeps the prepared source open", async () => {
    const prepared = source();
    const onExtractRange = vi.fn(async () => undefined);
    const onExtractFrame = vi.fn(async () => undefined);
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onExtractRange,
      onExtractFrame,
    });
    useMiniEditorStore.getState().setPlayhead(mediaSecondsToTick(3));

    useMiniEditorStore.getState().beginRangeExtraction();
    await useMiniEditorStore.getState().extractRange();
    useMiniEditorStore.getState().beginFrameExtraction();
    await useMiniEditorStore.getState().extractFrame();

    expect(onExtractRange).toHaveBeenCalledWith(
      {
        cropStartTicks: 0,
        cropEndTicks: prepared.durationTicks,
        ranges: [],
      },
      prepared,
    );
    expect(onExtractFrame).toHaveBeenCalledWith(
      mediaSecondsToTick(3),
      prepared,
    );
    expect(useMiniEditorStore.getState()).toMatchObject({
      isOpen: true,
      status: "ready",
      source: prepared,
      extractionMode: null,
    });
  });

  it("restores the previous selection when extraction selection is cancelled", async () => {
    const prepared = source();
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => prepared),
      onExtractRange: vi.fn(),
    });
    useMiniEditorStore
      .getState()
      .setCrop(mediaSecondsToTick(1), mediaSecondsToTick(8));
    useMiniEditorStore.getState().setPlayhead(mediaSecondsToTick(4));
    useMiniEditorStore.getState().beginRangeExtraction();
    useMiniEditorStore
      .getState()
      .setCrop(mediaSecondsToTick(2), mediaSecondsToTick(5));

    useMiniEditorStore.getState().cancelExtractionSelection();

    expect(useMiniEditorStore.getState()).toMatchObject({
      extractionMode: null,
      cropStartTicks: mediaSecondsToTick(1),
      cropEndTicks: mediaSecondsToTick(8),
      playheadTicks: mediaSecondsToTick(4),
    });
  });

  it("notifies an opener when another owner replaces its editor session", async () => {
    const onClose = vi.fn();
    await useMiniEditorStore.getState().open({
      openerId: "asset-browser",
      prepare: vi.fn(async () => source("blob:asset")),
      onClose,
    });

    await useMiniEditorStore.getState().open({
      openerId: "generation-panel",
      prepare: vi.fn(async () => source("blob:generation")),
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(useMiniEditorStore.getState().source?.sourceUrl).toBe(
      "blob:generation",
    );
  });

  it("updates navigation in place only for the active owner", async () => {
    const previous = vi.fn();
    await useMiniEditorStore.getState().open({
      openerId: "asset-browser",
      prepare: vi.fn(async () => source()),
    });

    useMiniEditorStore.getState().setNavigationState("generation-panel", {
      onPrevious: previous,
      hasPrevious: true,
      hasNext: false,
    });
    expect(useMiniEditorStore.getState()._internal.hasPrevious).toBe(false);

    useMiniEditorStore.getState().setNavigationState("asset-browser", {
      onPrevious: previous,
      hasPrevious: true,
      hasNext: false,
    });
    expect(useMiniEditorStore.getState()._internal).toMatchObject({
      onPrevious: previous,
      hasPrevious: true,
      hasNext: false,
    });
  });

  it("shows the success notice supplied by the extraction owner", async () => {
    await useMiniEditorStore.getState().open({
      prepare: vi.fn(async () => source()),
      onExtractFrame: vi.fn(async () => "Custom extraction complete."),
    });

    useMiniEditorStore.getState().beginFrameExtraction();
    await useMiniEditorStore.getState().extractFrame();

    expect(useMiniEditorStore.getState().notice).toBe(
      "Custom extraction complete.",
    );
  });
});
