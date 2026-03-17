import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workflowBridge", () => ({
  isIframeAppReady: vi.fn(),
  loadWorkflowIntoIframe: vi.fn(),
  readWorkflowFromIframe: vi.fn(),
}));

import {
  injectWorkflowAndRead,
  readWorkflowWithRetry,
  waitForAppReady,
} from "../workflowSyncController";
import {
  isIframeAppReady,
  loadWorkflowIntoIframe,
  readWorkflowFromIframe,
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
    vi.mocked(readWorkflowFromIframe)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        workflow: {},
        graphData: {},
        inputs: [],
        filename: null,
      });

    const result = await readWorkflowWithRetry(iframe, () => false, 300);
    expect(result).not.toBeNull();
    expect(result?.workflow).toEqual({});
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
    vi.mocked(readWorkflowFromIframe).mockResolvedValue({
      workflow: { "1": {} },
      graphData: { nodes: [] },
      inputs: [],
      filename: "wf.json",
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
});
