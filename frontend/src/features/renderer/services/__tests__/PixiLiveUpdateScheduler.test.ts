import { describe, expect, it, vi } from "vitest";
import { UPDATE_PRIORITY, type Ticker } from "pixi.js";
import { PixiLiveUpdateScheduler } from "../PixiLiveUpdateScheduler";

describe("PixiLiveUpdateScheduler", () => {
  it("replaces work with the latest task for a key and flushes before render", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const ticker = { add, remove } as unknown as Ticker;
    const scheduler = new PixiLiveUpdateScheduler(ticker);
    const first = vi.fn();
    const latest = vi.fn();

    scheduler.schedule("mask", first);
    scheduler.schedule("mask", latest);
    scheduler.flush();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      scheduler.flush,
      scheduler,
      UPDATE_PRIORITY.HIGH,
    );

    scheduler.dispose();
    expect(remove).toHaveBeenCalledWith(scheduler.flush, scheduler);
  });
});
