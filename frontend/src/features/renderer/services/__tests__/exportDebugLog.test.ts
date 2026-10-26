import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebugStore } from "../../../../shared/debug/useDebugStore";
import { EXPORT_DEBUG_SUMMARY_INTERVAL_MS, startExportDebugLog } from "../exportDebugLog";

describe("export debug log", () => {
  let info: ReturnType<typeof vi.spyOn>;
  const lines = (): string[] => info.mock.calls.map((call: unknown[]) => call.join(" "));

  beforeEach(() => {
    vi.useFakeTimers();
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    useDebugStore.getState().setDebugMode(false);
    info.mockRestore();
    vi.useRealTimers();
  });

  it("stays silent and costs nothing outside debug mode", () => {
    expect(startExportDebugLog("project export")).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it("reports the backlog, finishing steps and outcome of one render", () => {
    useDebugStore.getState().setDebugMode(true);
    const log = startExportDebugLog("project export")!;

    log.mark("renderer ready");
    log.onPhaseChange("rendering");
    log.onDiagnostic({ kind: "encoder-config", outputId: "video",
      config: { codec: "avc1.640028", width: 1920, height: 1080, hardwareAcceleration: "no-preference" } });
    for (let frame = 0; frame < 5; frame += 1) {
      log.onDiagnostic({ kind: "frame", frameIndex: frame, renderMilliseconds: 10, outputMilliseconds: 4 });
    }
    log.onDiagnostic({ kind: "video-packet", outputId: "video", timestamp: 0, bytes: 1, submissionToPacketMilliseconds: 1500 });
    vi.advanceTimersByTime(EXPORT_DEBUG_SUMMARY_INTERVAL_MS);
    log.onDiagnostic({ kind: "finishing", stage: "mux-finalize", outputId: "video", state: "completed", elapsedMilliseconds: 1100 });
    log.finish("completed");
    log.finish("failed");

    const output = lines();
    expect(output.some((line) => line.includes("renderer ready"))).toBe(true);
    expect(output.some((line) => line.includes("phase rendering"))).toBe(true);
    expect(output.some((line) => line.includes("avc1.640028"))).toBe(true);
    expect(output.some((line) => line.includes("submitted 5, encoded 1, backlog 4")
      && line.includes("render 10.0 ms") && line.includes("submit→packet 1.5 s"))).toBe(true);
    expect(output.some((line) => line.includes("finished mux-finalize (video) 1.10 s"))).toBe(true);
    expect(output.filter((line) => line.includes("5 frames submitted, 1 packets encoded"))).toHaveLength(1);
    // Totals separate frame work from wall time, and name each phase's share.
    const final = output.find((line) => line.includes("5 frames submitted"))!;
    expect(final).toContain("frame work: render 0.05 s, output 0.02 s");
    expect(final).toMatch(/of \d+\.\d{2} s wall/);
    expect(final).toContain("phases: rendering ");

    // The periodic summary stops with the render.
    const printed = info.mock.calls.length;
    vi.advanceTimersByTime(EXPORT_DEBUG_SUMMARY_INTERVAL_MS * 3);
    expect(info.mock.calls.length).toBe(printed);
  });
});
