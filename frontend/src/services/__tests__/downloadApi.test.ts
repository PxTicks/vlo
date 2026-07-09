import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelDownload,
  getAvailableModels,
  startModelDownload,
  startModelDownloadBatch,
  subscribeToProgress,
  type DownloadProgressEvent,
} from "../downloadApi";

class MockEventSource {
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = 0;
  onerror: (() => void) | null = null;
  close = vi.fn();
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data }));
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("downloadApi", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a friendly error when the model list endpoint responds with HTML", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("<!DOCTYPE html><html><body>Not JSON</body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      }),
    );

    await expect(getAvailableModels()).rejects.toThrow(
      "Unable to load SAM2 model list",
    );
  });

  it("preserves JSON detail when starting a download fails", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "A download is already in progress for one or more destination files",
        }),
        {
          status: 409,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    await expect(
      startModelDownload("sam2", "sam2.1_hiera_small"),
    ).rejects.toThrow(
      "A download is already in progress for one or more destination files",
    );
  });

  it("requests workflow-scoped model listings with the workflow id query", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          sam2: [],
          comfyui: {
            modelDownloadsEnabled: true,
            workflowModels: [],
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    await getAvailableModels({ workflowId: "wf.json" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/downloads/models?workflowId=wf.json"),
    );
  });

  it("posts the workflow graph when listing models for an editor-opened workflow", async () => {
    const workflowGraph = { nodes: [{ properties: { models: [] } }] };
    const payload = { sam2: [], comfyui: { modelDownloadsEnabled: true, workflowModels: [] } };
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(payload));

    await expect(
      getAvailableModels({ workflowId: "__temp__", workflowGraph }),
    ).resolves.toEqual(payload);

    // A graph cannot ride on a GET query string.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/downloads\/models$/),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: "__temp__", workflowGraph }),
      }),
    );
  });

  it("posts the workflow graph even without a workflow id", async () => {
    const workflowGraph = { nodes: [] };
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ sam2: [] }));

    await getAvailableModels({ workflowGraph });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/downloads\/models$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workflowGraph }),
      }),
    );
  });

  it("falls back to the GET query when the graph is null", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ sam2: [] }));

    await getAvailableModels({ workflowId: "wf.json", workflowGraph: null });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/downloads/models?workflowId=wf.json"),
    );
  });

  it("sends the workflow graph when starting single and batch downloads", async () => {
    const workflowGraph = { nodes: [{ id: 1 }] };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ jobId: "job-1", label: "m", status: "pending" }),
    );

    await startModelDownload("comfyui-workflow", "checkpoints:m.safetensors", {
      workflowId: "__temp__",
      workflowGraph,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/downloads/start"),
      expect.objectContaining({
        body: JSON.stringify({
          modelType: "comfyui-workflow",
          modelKey: "checkpoints:m.safetensors",
          workflowId: "__temp__",
          workflowGraph,
        }),
      }),
    );

    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ jobs: [], errors: [] }));

    await startModelDownloadBatch("comfyui-workflow", ["checkpoints:m.safetensors"], {
      workflowId: "__temp__",
      workflowGraph,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/downloads/start-batch"),
      expect.objectContaining({
        body: JSON.stringify({
          modelType: "comfyui-workflow",
          modelKeys: ["checkpoints:m.safetensors"],
          workflowId: "__temp__",
          workflowGraph,
        }),
      }),
    );
  });

  it("omits the workflow graph from request bodies when it is null", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ jobId: "job-1", label: "m", status: "pending" }),
    );

    await startModelDownload("comfyui-workflow", "checkpoints:m.safetensors", {
      workflowId: "wf.json",
      workflowGraph: null,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/downloads/start"),
      expect.objectContaining({
        body: JSON.stringify({
          modelType: "comfyui-workflow",
          modelKey: "checkpoints:m.safetensors",
          workflowId: "wf.json",
        }),
      }),
    );
  });

  it("returns model listings and omits the query when no workflow is selected", async () => {
    const payload = { sam2: [{ key: "tiny", installed: true }] };
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(payload));

    await expect(getAvailableModels()).resolves.toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/downloads\/models$/),
    );
  });

  it.each([
    [jsonResponse({ message: "backend message" }, 500), "backend message"],
    [jsonResponse(" plain failure ", 500), "plain failure"],
    [jsonResponse({ detail: "   ", message: "fallback detail" }, 400), "fallback detail"],
    [jsonResponse([], 500), "Unable to load SAM2 model list (500)"],
    [
      new Response("{bad json", {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      "Unable to load SAM2 model list (500)",
    ],
  ])("normalizes model-list error responses", async (response, message) => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response);
    await expect(getAvailableModels()).rejects.toThrow(message);
  });

  it.each([
    new Response("", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response("{bad json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ])("rejects empty or malformed successful JSON", async (response) => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response);
    await expect(getAvailableModels()).rejects.toThrow(
      "Unable to load SAM2 model list",
    );
  });

  it("sends the workflow id when starting a workflow download", async () => {
    const payload = {
      jobId: "job-1",
      label: "model.safetensors",
      status: "pending",
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(payload));

    await expect(
      startModelDownload("comfyui-workflow", "checkpoints:model.safetensors", {
        workflowId: "wf.json",
        hfToken: "secret",
      }),
    ).resolves.toEqual(payload);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/downloads/start"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          modelType: "comfyui-workflow",
          modelKey: "checkpoints:model.safetensors",
          workflowId: "wf.json",
          hfToken: "secret",
        }),
      }),
    );
  });

  it("starts a batch with optional credentials and preserves partial errors", async () => {
    const payload = {
      jobs: [{ modelKey: "a", jobId: "job-a", label: "A", status: "queued" }],
      errors: [{ modelKey: "b", message: "not available" }],
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(payload));

    await expect(
      startModelDownloadBatch("sam2", ["a", "b"], {
        workflowId: "workflow.json",
        hfToken: "token",
      }),
    ).resolves.toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/downloads\/start-batch$/),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelType: "sam2",
          modelKeys: ["a", "b"],
          workflowId: "workflow.json",
          hfToken: "token",
        }),
      }),
    );
  });

  it("omits an empty token from single and batch requests", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({ jobId: "one", label: "One", status: "queued" }),
      )
      .mockResolvedValueOnce(jsonResponse({ jobs: [], errors: [] }));

    await startModelDownload("sam2", "one", { hfToken: "" });
    await startModelDownloadBatch("sam2", [], { hfToken: "" });

    const firstBody = JSON.parse(
      String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    const secondBody = JSON.parse(
      String(vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(firstBody).not.toHaveProperty("hfToken");
    expect(secondBody).not.toHaveProperty("hfToken");
  });

  it("cancels downloads and reports HTTP failures", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(cancelDownload("job/with spaces")).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/downloads/job/with spaces/cancel"),
      { method: "POST" },
    );
    await expect(cancelDownload("failed")).rejects.toThrow(
      "Failed to cancel download (503)",
    );
  });

  it("subscribes to every progress event and closes on cleanup", () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeToProgress("job-1", onEvent);
    const source = MockEventSource.instances[0];
    const event: DownloadProgressEvent = {
      jobId: "job-1",
      label: "Model",
      status: "downloading",
      progress: {
        currentFileIndex: 0,
        totalFiles: 1,
        currentFileBytes: 5,
        currentFileTotal: 10,
        overallBytes: 5,
        overallBytesTotal: 10,
      },
      error: null,
    };

    for (const type of [
      "queued",
      "downloading",
      "complete",
      "failed",
      "cancelled",
    ]) {
      source.emit(type, JSON.stringify({ ...event, status: type }));
    }
    source.emit("downloading", "{bad json");

    expect(source.url).toMatch(/\/downloads\/job-1\/progress$/);
    expect(onEvent).toHaveBeenCalledTimes(5);
    unsubscribe();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("reports open connection errors but ignores errors after closure", () => {
    const onError = vi.fn();
    subscribeToProgress("job-2", vi.fn(), onError);
    const source = MockEventSource.instances[0];

    source.onerror?.();
    expect(onError).toHaveBeenCalledWith(
      new Error("Download progress connection lost"),
    );
    expect(source.close).toHaveBeenCalledTimes(1);

    source.readyState = MockEventSource.CLOSED;
    source.onerror?.();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
