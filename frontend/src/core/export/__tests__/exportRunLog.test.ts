import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginExportRun,
  EXPORT_RUN_HISTORY_LIMIT,
  getActiveExportRun,
  getExportRunRevision,
  getLatestExportRun,
  listExportRuns,
  resetExportRunLogForTests,
  subscribeExportRuns,
} from "../exportRunLog";

function run(startTicks = 0, endTicks = 100) {
  return beginExportRun({ kind: "range", startTicks, endTicks });
}

beforeEach(() => {
  resetExportRunLogForTests();
});

describe("export run log", () => {
  it("reports the run in flight separately from the last one to finish", () => {
    expect(getActiveExportRun()).toBeNull();
    expect(getLatestExportRun()).toBeNull();

    const first = run();
    expect(getActiveExportRun()?.id).toBe(first.id);

    first.complete({ assetId: "asset-1" });
    expect(getActiveExportRun()).toBeNull();
    expect(getLatestExportRun()).toMatchObject({
      id: first.id,
      status: "completed",
      progress: 1,
      assetId: "asset-1",
    });
  });

  it("normalises the renderer's percentage and ignores rubbish", () => {
    const handle = run();
    handle.reportProgress(45);
    expect(getLatestExportRun()?.progress).toBeCloseTo(0.45);

    handle.reportProgress(Number.NaN);
    handle.reportProgress(400);
    expect(getLatestExportRun()?.progress).toBe(1);
  });

  it("keeps a settled run settled", () => {
    const handle = run();
    handle.cancel();
    // A renderer that is already tearing down still emits progress, and a
    // late callback must not revive a run someone has already been told about.
    handle.reportProgress(90);
    handle.complete({ assetId: "asset-late" });
    handle.fail(new Error("later still"));

    expect(getLatestExportRun()).toMatchObject({
      status: "cancelled",
      assetId: null,
      error: null,
    });
  });

  it("moves the revision on every observable change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeExportRuns(listener);
    const before = getExportRunRevision();

    const handle = run();
    handle.reportProgress(10);
    // The same progress twice is not a change, so it does not notify.
    handle.reportProgress(10);
    handle.complete();

    expect(listener).toHaveBeenCalledTimes(3);
    expect(getExportRunRevision()).toBe(before + 3);

    unsubscribe();
    run();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps the history bounded, newest first", () => {
    for (let index = 0; index < EXPORT_RUN_HISTORY_LIMIT + 5; index += 1) {
      run(index, index + 10).complete();
    }

    const runs = listExportRuns();
    expect(runs).toHaveLength(EXPORT_RUN_HISTORY_LIMIT);
    expect(runs[0]?.startTicks).toBe(EXPORT_RUN_HISTORY_LIMIT + 4);
    expect(runs.at(-1)?.startTicks).toBe(5);
  });

  it("survives a listener that throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = vi.fn();
    const unsubscribeBad = subscribeExportRuns(() => {
      throw new Error("listener bug");
    });
    const unsubscribeGood = subscribeExportRuns(good);

    run().complete();

    expect(good).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    unsubscribeBad();
    unsubscribeGood();
    warn.mockRestore();
  });
});
