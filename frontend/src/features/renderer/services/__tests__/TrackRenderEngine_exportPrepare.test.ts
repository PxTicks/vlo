import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import {
  createDecoderWorkerPool,
  resetSharedDecoderWorkerPoolForTests,
} from "../DecoderWorkerPool";
import { resetDecoderWorkerRecoveryForTests } from "../../utils/decoderWorkerRecovery";

interface MockWorker {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: Mock;
  terminate: Mock;
}

const mockWorkers: MockWorker[] = [];
vi.mock("@decoder-worker-loader", () => ({
  default: class MockWorkerClass implements MockWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() {
      mockWorkers.push(this);
      setTimeout(() => {
        this.onmessage?.({
          data: { type: "worker-health", event: "boot" },
        } as MessageEvent);
      }, 0);
    }
  },
}));

import { TrackRenderEngine } from "../TrackRenderEngine";

/**
 * Regression: export prepares decoder sources through
 * prepareClipsForExportFrame(), which must key the prepare relevance window off
 * the *resolved effective tick*, not the raw presentation tick. Under
 * ripple/static retiming a clip can be active at presentation while its stored
 * start/end sit outside the lookahead/cleanup window relative to presentation
 * time — keying off the raw tick would skip the prepare (or evict the source)
 * and renderFrame() would then get a black/missing strict frame.
 */
describe("TrackRenderEngine.prepareClipsForExportFrame effective-tick keying", () => {
  const engines: TrackRenderEngine[] = [];
  let decoderPool: ReturnType<typeof createDecoderWorkerPool>;

  beforeEach(() => {
    mockWorkers.length = 0;
    resetSharedDecoderWorkerPoolForTests();
    resetDecoderWorkerRecoveryForTests();
    decoderPool = createDecoderWorkerPool({ label: "test", size: 1 });
  });

  afterEach(() => {
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
    decoderPool.dispose();
  });

  const clip: TimelineClip = {
    id: "c1",
    trackId: "t1",
    type: "video",
    assetId: "a1",
    start: 0,
    timelineDuration: 2 * TICKS_PER_SECOND,
    offset: 0,
  } as unknown as TimelineClip;

  // blob: src => embedded, so syncPreparedClips posts the prepare synchronously
  // (no async hydration to wait on).
  const asset: Asset = {
    id: "a1",
    type: "video",
    name: "a1.mp4",
    src: "blob:a1",
  } as unknown as Asset;

  function createEngine() {
    const engine = new TrackRenderEngine(1, undefined, undefined, {
      trackId: "t1",
      decoderPool,
    });
    engines.push(engine);
    return engine;
  }

  function preparedClipIds(): string[] {
    return mockWorkers
      .flatMap((worker) => worker.postMessage.mock.calls.map((call) => call[0]))
      .filter((message) => message?.type === "prepare")
      .map((message) => message.clipId as string);
  }

  // A presentation tick well past the clip's stored end + cleanup window, so the
  // clip is NOT relevant when the window is keyed off raw presentation time.
  const farPresentationTick = 10 * TICKS_PER_SECOND;

  it("prepares a clip that is in-window at its effective tick but not at the raw presentation tick", () => {
    const engine = createEngine();
    // Retiming: clip is active at presentation `farPresentationTick`, resolving
    // to an effective tick of 0 (inside its stored 0..2s range).
    vi.spyOn(engine, "resolveActiveClipAtPresentation").mockReturnValue({
      activeClip: clip,
      effectiveTick: 0,
    });

    engine.prepareClipsForExportFrame(farPresentationTick, [clip], [asset]);

    expect(preparedClipIds().some((id) => id.endsWith("/c1"))).toBe(true);
  });

  it("does not prepare when the effective tick is also out of window (guards against a vacuous test)", () => {
    const engine = createEngine();
    // No retiming: effective tick equals the far presentation tick, so the
    // clip's stored range is genuinely outside the window and must be skipped.
    vi.spyOn(engine, "resolveActiveClipAtPresentation").mockReturnValue({
      activeClip: clip,
      effectiveTick: farPresentationTick,
    });

    engine.prepareClipsForExportFrame(farPresentationTick, [clip], [asset]);

    expect(preparedClipIds().some((id) => id.endsWith("/c1"))).toBe(false);
  });
});
