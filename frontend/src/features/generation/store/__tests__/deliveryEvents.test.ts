import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchDeliveryFileAsFile,
  mockFrontendPostprocess,
  mockWaitForAssetsPersistence,
} = vi.hoisted(() => ({
  mockFetchDeliveryFileAsFile: vi.fn(),
  mockFrontendPostprocess: vi.fn(),
  mockWaitForAssetsPersistence: vi.fn(),
}));

vi.mock("../../../userAssets", () => ({
  waitForAssetsPersistence: mockWaitForAssetsPersistence,
}));

vi.mock("../../utils/pipeline", () => ({
  frontendPostprocess: mockFrontendPostprocess,
}));

vi.mock("../../services/generationDeliveryApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/generationDeliveryApi")>();
  return {
    ...actual,
    fetchDeliveryFileAsFile: mockFetchDeliveryFileAsFile,
  };
});

import { useGenerationStore } from "../../useGenerationStore";
import { attachDeliveryClientHandlers } from "../deliveryEvents";
import type { GenerationJob } from "../../types";
import type { GenerationStoreSet } from "../types";
import type {
  GenerationDeliveryManifest,
  GenerationDeliveryMessage,
} from "../../services/generationDeliveryApi";
import type { ParsedBinaryPreview } from "../../services/previewBinary";

class FakeDeliveryClient {
  readonly acknowledgedDeliveryIds: string[] = [];
  readonly rejectedDeliveries: Array<{ deliveryId: string; error: string }> = [];
  private readonly messageHandlers = new Set<
    (message: GenerationDeliveryMessage) => void
  >();
  private readonly previewHandlers = new Set<
    (preview: ParsedBinaryPreview) => void
  >();
  private readonly connectionChangeHandlers = new Set<
    (state: "connected" | "disconnected") => void
  >();

  acknowledgeDelivery(deliveryId: string): void {
    this.acknowledgedDeliveryIds.push(deliveryId);
  }

  rejectDelivery(deliveryId: string, error: string): void {
    this.rejectedDeliveries.push({ deliveryId, error });
  }

  onMessage(handler: (message: GenerationDeliveryMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onPreview(handler: (preview: ParsedBinaryPreview) => void): () => void {
    this.previewHandlers.add(handler);
    return () => {
      this.previewHandlers.delete(handler);
    };
  }

  onConnectionChange(
    handler: (state: "connected" | "disconnected") => void,
  ): () => void {
    this.connectionChangeHandlers.add(handler);
    return () => {
      this.connectionChangeHandlers.delete(handler);
    };
  }

  emitMessage(message: GenerationDeliveryMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitPreview(preview: ParsedBinaryPreview): void {
    for (const handler of this.previewHandlers) {
      handler(preview);
    }
  }

  emitConnectionChange(state: "connected" | "disconnected"): void {
    for (const handler of this.connectionChangeHandlers) {
      handler(state);
    }
  }
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

function makeQueuedJob(id: string): GenerationJob {
  return {
    id,
    deliveryId: "delivery-1",
    status: "queued",
    progress: 0,
    currentNode: null,
    outputs: [],
    error: null,
    submittedAt: Date.now(),
    completedAt: null,
    generationMetadata: {
      source: "generated",
      workflowName: "Workflow One",
      inputs: [],
    },
    postprocessConfig: {
      mode: "auto",
      panel_preview: "raw_outputs",
      on_failure: "fallback_raw",
    },
  };
}

function makeCompletedManifest(
  overrides: Partial<GenerationDeliveryManifest> = {},
): GenerationDeliveryManifest {
  return {
    delivery_id: "delivery-1",
    project_id: "project-1",
    prompt_id: "prompt-1",
    status: "completed_pending_ack",
    progress: 100,
    current_node: null,
    error: null,
    generation_metadata: {
      source: "generated",
      workflowName: "Workflow One",
      inputs: [],
    },
    postprocess_config: {
      mode: "auto",
      panel_preview: "raw_outputs",
      on_failure: "fallback_raw",
    },
    auto_family_request_key: "generation-family-request:v1:test",
    outputs: [
      {
        filename: "output.png",
        subfolder: "",
        type: "output",
        viewUrl: "/output.png",
      },
    ],
    preview_frames: [],
    prepared_mask: null,
    ...overrides,
  };
}

describe("deliveryEvents", () => {
  let client: FakeDeliveryClient;
  let mockProcessGenerationQueue: () => Promise<void>;

  beforeEach(() => {
    client = new FakeDeliveryClient();
    mockProcessGenerationQueue = vi.fn(async () => {});
    mockFetchDeliveryFileAsFile.mockReset();
    mockFrontendPostprocess.mockReset();
    mockWaitForAssetsPersistence.mockReset();
    mockFetchDeliveryFileAsFile.mockResolvedValue(null);

    useGenerationStore.setState({
      jobs: new Map<string, GenerationJob>([["prompt-1", makeQueuedJob("prompt-1")]]),
      jobPreviewFrames: new Map(),
      activeJobId: "prompt-1",
      latestPreviewUrl: null,
      previewAnimation: null,
      postprocessingJobIds: [],
      deliveryConnectionStatus: "disconnected",
      processGenerationQueue: mockProcessGenerationQueue,
    });

    const set: GenerationStoreSet = (partial) => {
      useGenerationStore.setState(partial as never);
    };
    attachDeliveryClientHandlers(
      client as never,
      set,
      useGenerationStore.getState,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ingests completed deliveries and acknowledges only after persistence", async () => {
    let resolvePersistence!: () => void;
    mockFrontendPostprocess.mockResolvedValue({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-1"],
    });
    mockWaitForAssetsPersistence.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePersistence = resolve;
        }),
    );

    client.emitConnectionChange("connected");
    client.emitMessage({
      type: "lease_state",
      data: { project_id: "project-1", active: true },
    });
    client.emitMessage({
      type: "delivery_update",
      data: { delivery: makeCompletedManifest() },
    });
    await flushMicrotasks();

    expect(useGenerationStore.getState().postprocessingJobIds).toEqual([
      "prompt-1",
    ]);
    expect(mockFrontendPostprocess).toHaveBeenCalledWith(
      [
        {
          filename: "output.png",
          subfolder: "",
          type: "output",
          viewUrl: "/output.png",
        },
      ],
      expect.objectContaining({
        autoFamilyRequestKey: "generation-family-request:v1:test",
      }),
    );
    expect(client.acknowledgedDeliveryIds).toEqual([]);
    expect(mockProcessGenerationQueue).toHaveBeenCalledTimes(1);

    resolvePersistence();
    await flushMicrotasks();

    expect(client.acknowledgedDeliveryIds).toEqual(["delivery-1"]);
    expect(useGenerationStore.getState().postprocessingJobIds).toEqual([]);
    expect(useGenerationStore.getState().jobs.get("prompt-1")?.importedAssetIds).toEqual([
      "asset-1",
    ]);
  });

  it("rejects completed deliveries when ingestion fails", async () => {
    mockFrontendPostprocess.mockRejectedValue(new Error("Held ingest failed"));
    mockWaitForAssetsPersistence.mockResolvedValue(undefined);

    client.emitMessage({
      type: "lease_state",
      data: { project_id: "project-1", active: true },
    });
    client.emitMessage({
      type: "delivery_update",
      data: { delivery: makeCompletedManifest() },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(client.acknowledgedDeliveryIds).toEqual([]);
    expect(client.rejectedDeliveries).toEqual([
      { deliveryId: "delivery-1", error: "Held ingest failed" },
    ]);
    expect(useGenerationStore.getState().jobs.get("prompt-1")?.postprocessError).toBe(
      "Held ingest failed",
    );
  });

  it("routes running and error delivery updates into the generation store", async () => {
    client.emitMessage({
      type: "lease_state",
      data: { project_id: "project-1", active: true },
    });
    client.emitMessage({
      type: "delivery_update",
      data: {
        delivery: makeCompletedManifest({
          status: "running",
          progress: 42,
          current_node: "ksampler",
          outputs: [],
        }),
      },
    });

    const runningState = useGenerationStore.getState();
    expect(runningState.jobs.get("prompt-1")).toMatchObject({
      status: "running",
      progress: 42,
      currentNode: "ksampler",
    });
    expect(runningState.activeJobId).toBe("prompt-1");

    client.emitMessage({
      type: "delivery_update",
      data: {
        delivery: makeCompletedManifest({
          status: "error",
          progress: 42,
          current_node: null,
          error: "Generation failed",
          outputs: [],
        }),
      },
    });

    const errorState = useGenerationStore.getState();
    expect(errorState.jobs.get("prompt-1")).toMatchObject({
      status: "error",
      error: "Generation failed",
    });
    expect(errorState.activeJobId).toBeNull();
    expect(mockProcessGenerationQueue).toHaveBeenCalledTimes(1);
  });

  it("uses held preview frames for websocket delivery postprocessing and clears cached previews", async () => {
    mockFetchDeliveryFileAsFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        new File(["frame-1"], "ws-000000.png", { type: "image/png" }),
      )
      .mockResolvedValueOnce(
        new File(["frame-2"], "ws-000001.png", { type: "image/png" }),
      );
    mockFrontendPostprocess.mockResolvedValue({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-1"],
    });
    mockWaitForAssetsPersistence.mockResolvedValue(undefined);

    useGenerationStore.setState({
      jobPreviewFrames: new Map([
        [
          "prompt-1",
          [new File(["stale"], "stale.png", { type: "image/png" })],
        ],
      ]),
    });

    client.emitMessage({
      type: "lease_state",
      data: { project_id: "project-1", active: true },
    });
    client.emitMessage({
      type: "delivery_update",
      data: {
        delivery: makeCompletedManifest({
          outputs: [
            {
              filename: "ws-000001.png",
              subfolder: "",
              type: "output",
              viewUrl:
                "/app/generation-delivery/projects/project-1/deliveries/delivery-1/files/preview_frames/ws-000001.png",
            },
          ],
          preview_frames: [
            {
              filename: "ws-000000.png",
              download_url:
                "/app/generation-delivery/projects/project-1/deliveries/delivery-1/files/preview_frames/ws-000000.png",
              mime_type: "image/png",
            },
            {
              filename: "ws-000001.png",
              download_url:
                "/app/generation-delivery/projects/project-1/deliveries/delivery-1/files/preview_frames/ws-000001.png",
              mime_type: "image/png",
            },
          ],
        }),
      },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockFrontendPostprocess).toHaveBeenCalledWith(
      [
        {
          filename: "ws-000001.png",
          subfolder: "",
          type: "output",
          viewUrl:
            "/app/generation-delivery/projects/project-1/deliveries/delivery-1/files/preview_frames/ws-000001.png",
        },
      ],
      expect.objectContaining({
        previewFrameFiles: [
          expect.objectContaining({ name: "ws-000000.png" }),
          expect.objectContaining({ name: "ws-000001.png" }),
        ],
      }),
    );
    expect(useGenerationStore.getState().jobPreviewFrames.has("prompt-1")).toBe(false);
  });

});
