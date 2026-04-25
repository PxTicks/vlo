import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workflowBridge", async () => {
  const actual = await vi.importActual<typeof import("../workflowBridge")>(
    "../workflowBridge",
  );
  return {
    ...actual,
    isIframeAppReady: vi.fn(),
    loadWorkflowIntoIframe: vi.fn(),
    readActiveWorkflowFromIframe: vi.fn(),
  };
});

import {
  injectWorkflowAndRead,
  readWorkflowWithRetry,
  waitForAppReady,
} from "../workflowSyncController";
import {
  isIframeAppReady,
  loadWorkflowIntoIframe,
  readActiveWorkflowFromIframe,
} from "../workflowBridge";

describe("workflowSyncController", () => {
  const iframe = {} as HTMLIFrameElement;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("waitForAppReady returns true when iframe app becomes ready", async () => {
    vi.mocked(isIframeAppReady)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const ready = await waitForAppReady(iframe, () => false, 300);
    expect(ready).toBe(true);
  });

  it("readWorkflowWithRetry returns first readable workflow", async () => {
    vi.mocked(readActiveWorkflowFromIframe)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        graphData: {
          nodes: [{ id: 1, type: "LoadImage" }],
          links: [],
        },
        filename: "wf.json",
        isModified: true,
      });

    const result = await readWorkflowWithRetry(iframe, () => false, 300);
    expect(result).not.toBeNull();
    expect(result?.filename).toBe("wf.json");
    // Visual-graph reads no longer synthesize a fake API workflow; only
    // graphToPrompt produces one, so this path leaves `workflow` null.
    expect(result?.workflow).toBeNull();
    expect(result?.graphData).toEqual({
      nodes: [{ id: 1, type: "LoadImage" }],
      links: [],
    });
  });

  it("readWorkflowWithRetry skips stale workflows until an acceptable result appears", async () => {
    vi.mocked(readActiveWorkflowFromIframe)
      .mockReturnValueOnce({
        graphData: { nodes: [{ id: 1, type: "OldWorkflow" }], links: [] },
        filename: "video_ltx2_3_i2v.json",
        isModified: false,
      })
      .mockReturnValueOnce({
        graphData: { nodes: [{ id: 98, type: "LoadVideo" }], links: [] },
        filename: "__temp__.json",
        isModified: true,
      });

    const result = await readWorkflowWithRetry(
      iframe,
      () => false,
      300,
      undefined,
      undefined,
      (candidate) => candidate.filename === "__temp__.json",
    );

    expect(result).not.toBeNull();
    expect(result?.filename).toBe("__temp__.json");
    expect(readActiveWorkflowFromIframe).toHaveBeenCalledTimes(2);
  });

  it("injectWorkflowAndRead defers when app readiness fails", async () => {
    vi.mocked(isIframeAppReady).mockReturnValue(false);
    const result = await injectWorkflowAndRead(
      iframe,
      {},
      "wf.json",
      () => true,
    );

    expect(result.ok).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.reason).toBe("iframe app not ready");
    expect(loadWorkflowIntoIframe).not.toHaveBeenCalled();
  });

  it("injectWorkflowAndRead returns synced workflow payload", async () => {
    vi.mocked(isIframeAppReady).mockReturnValue(true);
    vi.mocked(loadWorkflowIntoIframe).mockResolvedValue({
      ok: true,
      warnings: null,
    });
    vi.mocked(readActiveWorkflowFromIframe).mockReturnValue({
      graphData: { nodes: [{ id: 1, type: "LoadImage" }], links: [] },
      filename: "wf.json",
      isModified: true,
    });

    const result = await injectWorkflowAndRead(
      iframe,
      { nodes: [] },
      "wf.json",
      () => false,
    );

    expect(result.ok).toBe(true);
    expect(result.deferred).toBe(false);
    expect(result.workflowResult?.filename).toBe("wf.json");
  });

  it("injectWorkflowAndRead ignores stale iframe reads from the previously active workflow", async () => {
    vi.mocked(isIframeAppReady).mockReturnValue(true);
    vi.mocked(loadWorkflowIntoIframe).mockResolvedValue({
      ok: true,
      warnings: null,
    });
    vi.mocked(readActiveWorkflowFromIframe)
      .mockReturnValueOnce({
        graphData: { nodes: [{ id: 1, type: "LoadImage" }], links: [] },
        filename: "video_ltx2_3_i2v.json",
        isModified: false,
      })
      .mockReturnValueOnce({
        graphData: { nodes: [{ id: 98, type: "LoadVideo" }], links: [] },
        filename: "__temp__.json",
        isModified: true,
      });

    const result = await injectWorkflowAndRead(
      iframe,
      { nodes: [{ id: 98, type: "LoadVideo" }] },
      "__temp__",
      () => false,
    );

    expect(result.ok).toBe(true);
    expect(result.deferred).toBe(false);
    expect(result.workflowResult?.filename).toBe("__temp__.json");
    expect(readActiveWorkflowFromIframe).toHaveBeenCalledTimes(2);
  });
});
