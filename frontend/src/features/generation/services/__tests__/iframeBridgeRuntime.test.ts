import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  fingerprintWorkflow,
  startVloBridge,
} from "../../../../../../backend/assets/comfyui_bridge/bridge-core.mjs";

interface RuntimeMessageEvent {
  source: unknown;
  origin: string;
  data: Record<string, unknown>;
}

function createHarness() {
  const messageListeners = new Set<(event: RuntimeMessageEvent) => void>();
  const apiListeners = new Map<string, Set<(event?: unknown) => void>>();
  const posted: Array<Record<string, unknown>> = [];
  const parent = {
    location: { origin: "http://vlo.test" },
    postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)),
  };
  // Mirrors ComfyUI ≥1.45 semantics: `filename` is extension-stripped and
  // `activeState` is a Vue reactive Proxy that structuredClone rejects.
  const activeWorkflow = {
    filename: "workflow",
    fullFilename: "workflow.json",
    key: "workflow.json",
    path: "workflows/workflow.json",
    isModified: false,
    activeState: new Proxy(
      {
        nodes: [{ id: "node-a", type: "LoadImage" }],
        links: [],
      },
      {},
    ),
    pendingWarnings: null,
  };
  // Present in `workflows` (persisted list) but not `openWorkflows`; the
  // bridge must never close it.
  const persistedTemplate = {
    filename: "Image Blur",
    key: "Image Blur.json",
    path: "subgraphs/Image Blur.json",
  };
  const otherOpenTab = {
    filename: "scratch",
    key: "scratch.json",
    path: "workflows/scratch.json",
  };
  const liveNode = {
    id: "node-a",
    mode: 0,
    widgets: [{ name: "image", value: "live.png" }],
  };
  const liveGraph = {
    serialize: vi.fn(() => ({
      nodes: [
        {
          id: liveNode.id,
          type: "LoadImage",
          mode: liveNode.mode,
          widgets_values: [liveNode.widgets[0].value],
        },
      ],
      links: [],
    })),
  };

  class FakeLGraph {
    nodes = new Map<string | number, typeof liveNode>();

    configure(serialized: { nodes: Array<Record<string, unknown>> }) {
      for (const node of serialized.nodes) {
        const widgetValues = Array.isArray(node.widgets_values)
          ? node.widgets_values
          : [];
        this.nodes.set(node.id as string, {
          id: node.id as string,
          mode: (node.mode as number) ?? 0,
          widgets: [{ name: "image", value: widgetValues[0] }],
        });
      }
    }

    getNodeById(id: string | number) {
      return this.nodes.get(id) ?? null;
    }
  }

  const app = {
    canvas: {},
    rootGraph: liveGraph,
    extensionManager: {
      spinner: false,
      workflow: {
        activeWorkflow,
        workflows: [activeWorkflow, otherOpenTab, persistedTemplate],
        openWorkflows: [activeWorkflow, otherOpenTab],
        closeWorkflow: vi.fn(),
      },
    },
    handleFile: vi.fn(),
    graphToPrompt: vi.fn(async (graph: FakeLGraph) => {
      const node = graph.getNodeById("node-a");
      return {
        output: {
          "node-a": {
            class_type: "LoadImage",
            inputs: { image: node?.widgets[0].value },
          },
        },
        workflow: {},
      };
    }),
    refreshMissingModels: vi.fn(),
  };
  const api = {
    clientId: "iframe-client-1",
    socket: { readyState: 1, OPEN: 1 },
    // ComfyUI's upload endpoint, used only when a loader has no drop handler.
    fetchApi: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: "staged.png", subfolder: "" }),
    })),
    addEventListener: vi.fn((name: string, handler: () => void) => {
      const handlers = apiListeners.get(name) ?? new Set();
      handlers.add(handler);
      apiListeners.set(name, handlers);
    }),
    removeEventListener: vi.fn(),
  };
  // jsdom ships no DataTransfer; the bridge only needs `items.add` and the
  // `types`/`files` a node drop handler reads back.
  class FakeDataTransfer {
    readonly files: File[] = [];
    readonly types: string[] = [];
    readonly items = {
      add: (file: File) => {
        this.files.push(file);
        if (!this.types.includes("Files")) this.types.push("Files");
      },
    };
  }
  const windowObject = {
    parent,
    location: { origin: "http://vlo.test" },
    crypto: { randomUUID: () => "workflow-instance" },
    structuredClone,
    LGraph: FakeLGraph,
    Blob,
    File,
    FormData,
    DataTransfer: FakeDataTransfer,
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(
      (name: string, handler: (event: RuntimeMessageEvent) => void) => {
        if (name === "message") messageListeners.add(handler);
      },
    ),
    removeEventListener: vi.fn(),
  };

  function send(
    data: Record<string, unknown>,
    origin = "http://vlo.test",
    source: unknown = parent,
  ) {
    for (const listener of messageListeners) {
      listener({ source, origin, data });
    }
  }

  function emitApi(name: string, event?: unknown) {
    for (const listener of apiListeners.get(name) ?? []) listener(event);
  }

  return {
    activeWorkflow,
    otherOpenTab,
    persistedTemplate,
    app,
    api,
    emitApi,
    liveNode,
    posted,
    send,
    windowObject,
  };
}

function hello(harness: ReturnType<typeof createHarness>) {
  harness.send({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    channelId: "channel-1",
    type: "hello",
  });
}

function dropFile(name = "clip.png", type = "image/png") {
  return new File(["bytes"], name, { type });
}

function request(
  harness: ReturnType<typeof createHarness>,
  requestId: string,
  method: string,
  payload?: unknown,
) {
  harness.send({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    channelId: "channel-1",
    type: "request",
    requestId,
    method,
    payload,
  });
}

describe("hosted iframe bridge runtime", () => {
  it("announces the complete v4 contract only to its same-origin parent", () => {
    const harness = createHarness();
    expect(
      startVloBridge({
        app: harness.app,
        api: harness.api,
        windowObject: harness.windowObject,
      }),
    ).not.toBeNull();

    harness.send(
      {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        channelId: "attacker",
        type: "hello",
      },
      "https://attacker.invalid",
    );
    expect(harness.posted).toHaveLength(0);

    harness.send({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION - 1,
      channelId: "old-version",
      type: "hello",
    });
    harness.send(
      {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        channelId: "wrong-source",
        type: "hello",
      },
      "http://vlo.test",
      {},
    );
    expect(harness.posted).toHaveLength(0);

    hello(harness);
    expect(harness.posted.at(-1)).toMatchObject({
      type: "ready",
      version: BRIDGE_VERSION,
      channelId: "channel-1",
      capabilities: [...BRIDGE_CAPABILITIES],
      clientId: "iframe-client-1",
    });
  });

  it("answers a handshake with 'booting' until ComfyUI is ready", () => {
    const harness = createHarness();
    harness.app.extensionManager.spinner = true;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });

    hello(harness);
    hello(harness);
    expect(harness.posted).toHaveLength(2);
    expect(harness.posted.every((message) => message.type === "booting")).toBe(
      true,
    );
    expect(harness.posted.at(-1)).toMatchObject({
      type: "booting",
      channelId: "channel-1",
      documentId: expect.any(String),
    });

    harness.app.extensionManager.spinner = false;
    hello(harness);
    expect(harness.posted.at(-1)).toMatchObject({
      type: "ready",
      documentId: expect.any(String),
    });
  });

  it("answers booting until ComfyUI assigns its websocket client id", () => {
    const harness = createHarness();
    harness.api.clientId = undefined as unknown as string;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });

    hello(harness);
    expect(harness.posted.at(-1)).toMatchObject({
      type: "booting",
      documentId: expect.any(String),
    });

    harness.api.clientId = "iframe-client-late";
    hello(harness);
    expect(harness.posted.at(-1)).toMatchObject({
      type: "ready",
      clientId: "iframe-client-late",
      documentId: expect.any(String),
    });
  });

  it("stamps one document id on every message it sends, not just the handshake", async () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });

    hello(harness);
    request(harness, "health-1", "health");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "health-1"),
      ).toBe(true),
    );
    harness.emitApi("status");

    expect(harness.posted.map((message) => message.type)).toEqual([
      "ready",
      "response",
      "event",
    ]);
    const documentIds = new Set(
      harness.posted.map((message) => message.documentId),
    );
    expect(documentIds.size).toBe(1);
    expect([...documentIds][0]).toEqual(expect.any(String));
  });

  it("forwards the iframe's own generation lifecycle, scoped to prompts it started", () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    harness.posted.length = 0;

    // A socket reconnect can lose execution_start while later lifecycle
    // events still arrive. Treat progress as an implicit start.
    harness.emitApi("progress", {
      detail: { prompt_id: "foreign", value: 1, max: 4 },
    });
    harness.emitApi("execution_success", {
      detail: { prompt_id: "foreign" },
    });
    expect(
      harness.posted
        .filter((message) => message.event === "iframe-generation")
        .map((message) => (message.data as { phase: string }).phase),
    ).toEqual(["started", "progress", "finished"]);
    harness.posted.length = 0;

    harness.emitApi("execution_start", { detail: { prompt_id: "p-1" } });
    harness.emitApi("progress", {
      detail: { prompt_id: "p-1", value: 2, max: 4, node: "ksampler" },
    });
    harness.emitApi("execution_success", { detail: { prompt_id: "p-1" } });

    const events = harness.posted.filter(
      (m) => m.event === "iframe-generation",
    );
    expect(events.map((m) => (m.data as { phase: string }).phase)).toEqual([
      "started",
      "progress",
      "finished",
    ]);
    expect(events[1].data).toMatchObject({
      promptId: "p-1",
      value: 2,
      max: 4,
      node: "ksampler",
    });

    // After the terminal event the prompt is forgotten; late progress is dropped.
    harness.emitApi("progress", {
      detail: { prompt_id: "p-1", value: 3, max: 4 },
    });
    expect(
      harness.posted.filter((m) => m.event === "iframe-generation"),
    ).toHaveLength(3);
  });

  it("replays generation lifecycle events that precede the parent handshake", () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });

    harness.emitApi("execution_start", { detail: { prompt_id: "p-early" } });
    harness.emitApi("execution_success", {
      detail: { prompt_id: "p-early" },
    });
    expect(
      harness.posted.filter((m) => m.event === "iframe-generation"),
    ).toHaveLength(0);

    hello(harness);

    const events = harness.posted.filter(
      (message) => message.event === "iframe-generation",
    );
    expect(events.map((message) => message.data)).toEqual([
      { promptId: "p-early", phase: "started" },
      { promptId: "p-early", phase: "finished" },
    ]);
  });

  it("collapses buffered progress and caps pending prompt lifecycles", () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });

    for (let index = 0; index < 300; index += 1) {
      harness.emitApi("execution_start", {
        detail: { prompt_id: `p-${index}` },
      });
    }
    harness.emitApi("execution_start", { detail: { prompt_id: "p-progress" } });
    for (let value = 1; value <= 5_001; value += 1) {
      harness.emitApi("progress", {
        detail: { prompt_id: "p-progress", value, max: 5_001 },
      });
    }

    hello(harness);

    const events = harness.posted.filter(
      (message) => message.event === "iframe-generation",
    );
    expect(events.length).toBeLessThanOrEqual(257);
    const progressEvents = events.filter(
      (message) =>
        (message.data as { promptId?: string }).promptId === "p-progress" &&
        (message.data as { phase?: string }).phase === "progress",
    );
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].data).toMatchObject({ value: 5_001 });
  });

  it("injects the workflow despite ComfyUI load-time drift and returns parsed warnings", async () => {
    const harness = createHarness();
    // Post-load activeState: object-form links with renumbered target slots,
    // behind a reactive Proxy — as the real frontend produces.
    harness.activeWorkflow.activeState = new Proxy(
      {
        nodes: [
          { id: "node-a", type: "LoadImage" },
          { id: "node-b", type: "PreviewImage" },
        ],
        links: [
          {
            origin_id: "node-a",
            origin_slot: 0,
            target_id: "node-b",
            target_slot: 2,
            type: "IMAGE",
          },
        ],
      },
      {},
    ) as never;
    harness.activeWorkflow.pendingWarnings = {
      missingNodeTypes: [{ type: "MissingNode" }],
      missingModelCandidates: [
        { name: "missing.safetensors", isMissing: true },
        { name: "installed.safetensors", isMissing: false },
      ],
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "inject-1", "inject-workflow", {
      // As-injected file: tuple-form links with pre-load slot numbering.
      graphData: {
        nodes: [
          { id: "node-a", type: "LoadImage" },
          { id: "node-b", type: "PreviewImage" },
        ],
        links: [[7, "node-a", 0, "node-b", 0, "IMAGE"]],
      },
      filename: "workflow.json",
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "inject-1"),
      ).toBe(true),
    );
    expect(harness.app.handleFile).toHaveBeenCalledTimes(1);
    expect(
      harness.posted.find((message) => message.requestId === "inject-1"),
    ).toMatchObject({
      ok: true,
      result: {
        warnings: {
          missingNodeTypes: ["MissingNode"],
          missingModels: ["missing.safetensors"],
        },
        snapshot: {
          filename: "workflow",
          workflowInstanceId: "workflow-instance",
        },
      },
    });
    const closeWorkflow = harness.app.extensionManager.workflow.closeWorkflow;
    expect(closeWorkflow).toHaveBeenCalledTimes(1);
    expect(closeWorkflow).toHaveBeenCalledWith(harness.otherOpenTab);
    expect(closeWorkflow).not.toHaveBeenCalledWith(harness.persistedTemplate);
  });

  it("accepts a de-duplicated tab name for the injected workflow", async () => {
    const harness = createHarness();
    harness.activeWorkflow.filename = "workflow (2)";
    harness.activeWorkflow.fullFilename = "workflow (2).json";
    harness.activeWorkflow.key = "workflow (2).json";
    harness.activeWorkflow.path = "workflows/workflow (2).json";
    harness.activeWorkflow.pendingWarnings = {
      missingNodeTypes: ["MissingNode"],
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "inject-dup", "inject-workflow", {
      graphData: { nodes: [{ id: "node-a", type: "LoadImage" }], links: [] },
      filename: "workflow.json",
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "inject-dup"),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "inject-dup"),
    ).toMatchObject({ ok: true });
  });

  it("resolves on a clone and leaves the live graph untouched", async () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-1", "read-active");
    await vi.waitFor(() =>
      expect(harness.posted.some((message) => message.requestId === "read-1")).toBe(true),
    );
    const readResponse = harness.posted.find(
      (message) => message.requestId === "read-1",
    );
    const snapshot = readResponse?.result as {
      workflowInstanceId: string;
      revision: number;
    };

    request(harness, "resolve-1", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: [],
      widgetOverrides: [
        { node_id: "node-a", widget: "image", value: "override.png" },
      ],
    });
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "resolve-1"),
      ).toBe(true),
    );
    const response = harness.posted.find(
      (message) => message.requestId === "resolve-1",
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        output: {
          "node-a": { inputs: { image: "override.png" } },
        },
      },
    });
    expect(harness.liveNode.widgets[0].value).toBe("live.png");
    expect(harness.liveNode.mode).toBe(0);
  });

  it("rejects prompt resolution after the active workflow revision changes", async () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-2", "read-active");
    await vi.waitFor(() =>
      expect(harness.posted.some((message) => message.requestId === "read-2")).toBe(true),
    );
    const read = harness.posted.find((message) => message.requestId === "read-2");
    const snapshot = read?.result as Record<string, unknown>;
    harness.emitApi("graphChanged");
    request(harness, "resolve-2", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: [],
      widgetOverrides: [],
    });
    await vi.waitFor(() =>
      expect(harness.posted.some((message) => message.requestId === "resolve-2")).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "resolve-2"),
    ).toMatchObject({
      ok: false,
      error: { code: "workflow-changed" },
    });
  });

  it("rejects a concurrent edit while graphToPrompt is running", async () => {
    const harness = createHarness();
    let finishResolution!: () => void;
    harness.app.graphToPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResolution = () =>
            resolve({
              output: {
                "node-a": {
                  class_type: "LoadImage",
                  inputs: { image: "live.png" },
                },
              },
              workflow: {},
            });
        }),
    );
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-concurrent", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "read-concurrent",
        ),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-concurrent",
    )?.result as Record<string, unknown>;

    request(harness, "resolve-concurrent", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: [],
      widgetOverrides: [],
    });
    await vi.waitFor(() => expect(finishResolution).toBeTypeOf("function"));
    harness.emitApi("graphChanged");
    finishResolution();

    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-concurrent",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "resolve-concurrent",
      ),
    ).toMatchObject({ ok: false, error: { code: "workflow-changed" } });
  });

  it("fails closed when the temporary graph cannot be configured", async () => {
    const harness = createHarness();
    harness.windowObject.LGraph = class {
      configure() {
        throw new Error("unsupported graph shape");
      }
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-clone", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "read-clone"),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-clone",
    )?.result as Record<string, unknown>;
    request(harness, "resolve-clone", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: [],
      widgetOverrides: [],
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-clone",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "resolve-clone"),
    ).toMatchObject({
      ok: false,
      error: { code: "clone-configure-failed" },
    });
  });

  it("creates a loader node at the drop position and stages the file itself when the node has no drop handler", async () => {
    const harness = createHarness();
    const dropGraph = {
      add: vi.fn((node: { id: number }) => {
        node.id = 42;
      }),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => null),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 2, offset: [10, 20] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    const createdNode = {
      id: 0,
      type: "LoadImage",
      size: [200, 60],
      pos: [0, 0] as number[],
      widgets: [
        {
          name: "image",
          value: "",
          options: { values: ["existing.png"] },
          callback: vi.fn(),
        },
      ],
      setDirtyCanvas: vi.fn(),
    };
    (harness.windowObject as unknown as { LiteGraph?: unknown }).LiteGraph = {
      createNode: vi.fn(() => createdNode),
    };
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "drop-create", "drop-asset", {
      clientX: 100,
      clientY: 200,
      file: dropFile(),
      targets: [{ classType: "LoadImage", widget: "image" }],
      create: { classType: "LoadImage", widget: "image" },
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "drop-create"),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "drop-create"),
    ).toMatchObject({
      ok: true,
      result: { action: "created", nodeId: "42", classType: "LoadImage" },
    });
    // Manual DragAndScale conversion: [100/2 - 10, 200/2 - 20] = [40, 80],
    // then the node is horizontally centered on the pointer (width 200).
    expect(dropGraph.getNodeOnPos).toHaveBeenCalledWith(40, 80);
    expect(createdNode.pos).toEqual([-60, 80]);
    expect(dropGraph.add).toHaveBeenCalledWith(createdNode);
    expect(harness.api.fetchApi).toHaveBeenCalledWith(
      "/upload/image",
      expect.objectContaining({ method: "POST" }),
    );
    expect(createdNode.widgets[0].value).toBe("staged.png");
    expect(createdNode.widgets[0].options.values).toContain("staged.png");
    expect(createdNode.widgets[0].callback).toHaveBeenCalledWith(
      "staged.png",
      harness.app.canvas,
      createdNode,
    );
  });

  it("hands the file to the drop handler of the loader under the pointer", async () => {
    const harness = createHarness();
    const dropped: Array<{ files: File[]; types: string[] }> = [];
    const existingNode = {
      id: 7,
      type: "VHS_LoadVideo",
      // Mirrors VHS.core.js: reads dataTransfer, uploads itself, assigns the
      // widget on success, reports true.
      onDragDrop: vi.fn(async (event: { dataTransfer: { files: File[]; types: string[] } }) => {
        dropped.push(event.dataTransfer);
        existingNode.widgets[0].value = "staged.mp4";
        return true;
      }),
      widgets: [
        { name: "video", value: "old.mp4", options: { values: [] }, callback: vi.fn() },
      ],
      setDirtyCanvas: vi.fn(),
    };
    const dropGraph = {
      add: vi.fn(),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => existingNode),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 1, offset: [0, 0] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    const file = dropFile("staged.mp4", "video/mp4");
    request(harness, "drop-update", "drop-asset", {
      clientX: 300,
      clientY: 120,
      file,
      targets: [{ classType: "VHS_LoadVideo", widget: "video" }],
      create: { classType: "VHS_LoadVideo", widget: "video" },
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "drop-update"),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "drop-update"),
    ).toMatchObject({
      ok: true,
      result: { action: "updated", nodeId: "7", classType: "VHS_LoadVideo" },
    });
    expect(dropped).toEqual([
      expect.objectContaining({ files: [file], types: ["Files"] }),
    ]);
    // The node owns the upload and the widget; the bridge touches neither.
    expect(harness.api.fetchApi).not.toHaveBeenCalled();
    expect(existingNode.widgets[0].value).toBe("staged.mp4");
    expect(dropGraph.add).not.toHaveBeenCalled();
  });

  it("offers the file to an unmapped node that implements the drop contract", async () => {
    const harness = createHarness();
    const unmappedNode = {
      id: 11,
      type: "SomeThirdPartyLoader",
      onDragDrop: vi.fn(async () => {
        unmappedNode.widgets[0].value = "staged.png";
        return true;
      }),
      widgets: [{ name: "media", value: "", options: { values: [] }, callback: vi.fn() }],
      setDirtyCanvas: vi.fn(),
    };
    const dropGraph = {
      add: vi.fn(),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => unmappedNode),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 1, offset: [0, 0] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "drop-unmapped", "drop-asset", {
      clientX: 10,
      clientY: 10,
      file: dropFile(),
      targets: [{ classType: "LoadImage", widget: "image" }],
      create: { classType: "LoadImage", widget: "image" },
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "drop-unmapped"),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "drop-unmapped"),
    ).toMatchObject({
      ok: true,
      result: { action: "updated", nodeId: "11", classType: "SomeThirdPartyLoader" },
    });
    expect(dropGraph.add).not.toHaveBeenCalled();
  });

  it("creates a loader when the node under the pointer declines the file", async () => {
    const harness = createHarness();
    const decliningNode = {
      id: 12,
      type: "LoadAudio",
      // Core loaders answer false for media they do not accept.
      onDragDrop: vi.fn(async () => false),
      widgets: [],
      setDirtyCanvas: vi.fn(),
    };
    const createdNode = {
      id: 0,
      type: "LoadImage",
      size: [200, 60],
      pos: [0, 0] as number[],
      widgets: [{ name: "image", value: "", options: { values: [] } }],
      setDirtyCanvas: vi.fn(),
    };
    const dropGraph = {
      add: vi.fn((node: { id: number }) => {
        node.id = 13;
      }),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => decliningNode),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 1, offset: [0, 0] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    (harness.windowObject as unknown as { LiteGraph?: unknown }).LiteGraph = {
      createNode: vi.fn(() => createdNode),
    };
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "drop-declined", "drop-asset", {
      clientX: 10,
      clientY: 10,
      file: dropFile(),
      targets: [{ classType: "LoadAudio", widget: "audio" }],
      create: { classType: "LoadImage", widget: "image" },
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "drop-declined"),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "drop-declined"),
    ).toMatchObject({
      ok: true,
      result: { action: "created", nodeId: "13", classType: "LoadImage" },
    });
    expect(createdNode.widgets[0].value).toBe("staged.png");
  });

  it("stages the file itself when a node claims the drop but changes nothing", async () => {
    const harness = createHarness();
    const silentNode = {
      id: 21,
      type: "VHS_LoadVideo",
      // ComfyUI's uploader swallows backend failures into a toast and still
      // answers true, leaving the widget untouched.
      onDragDrop: vi.fn(async () => true),
      widgets: [
        { name: "video", value: "old.mp4", options: { values: [] }, callback: vi.fn() },
      ],
      setDirtyCanvas: vi.fn(),
    };
    const dropGraph = {
      add: vi.fn(),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => silentNode),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 1, offset: [0, 0] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "drop-silent", "drop-asset", {
      clientX: 10,
      clientY: 10,
      file: dropFile("staged.mp4", "video/mp4"),
      targets: [{ classType: "VHS_LoadVideo", widget: "video" }],
      create: { classType: "VHS_LoadVideo", widget: "video" },
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "drop-silent"),
      ).toBe(true),
    );
    // Success is only reported because the bridge then staged the file itself.
    expect(harness.api.fetchApi).toHaveBeenCalledWith(
      "/upload/image",
      expect.objectContaining({ method: "POST" }),
    );
    expect(silentNode.widgets[0].value).toBe("staged.png");
    expect(
      harness.posted.find((message) => message.requestId === "drop-silent"),
    ).toMatchObject({
      ok: true,
      result: { action: "updated", nodeId: "21" },
    });
  });

  it("refuses to race a node that is already uploading", async () => {
    const harness = createHarness();
    const busyNode = {
      id: 22,
      type: "VHS_LoadVideo",
      isUploading: true,
      onDragDrop: vi.fn(async () => true),
      widgets: [
        { name: "video", value: "old.mp4", options: { values: [] }, callback: vi.fn() },
      ],
      setDirtyCanvas: vi.fn(),
    };
    const dropGraph = {
      add: vi.fn(),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => busyNode),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 1, offset: [0, 0] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "drop-busy", "drop-asset", {
      clientX: 10,
      clientY: 10,
      file: dropFile("staged.mp4", "video/mp4"),
      targets: [{ classType: "VHS_LoadVideo", widget: "video" }],
      create: null,
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "drop-busy"),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "drop-busy"),
    ).toMatchObject({
      ok: false,
      error: { code: "upload-in-progress" },
    });
    expect(busyNode.onDragDrop).not.toHaveBeenCalled();
    expect(harness.api.fetchApi).not.toHaveBeenCalled();
    expect(busyNode.widgets[0].value).toBe("old.mp4");
  });

  it("removes the node it created when the file cannot be delivered", async () => {
    const harness = createHarness();
    const createdNode = {
      id: 0,
      type: "LoadImage",
      size: [200, 60],
      pos: [0, 0] as number[],
      // No drop handler and no matching widget: nothing can take the file.
      widgets: [],
      setDirtyCanvas: vi.fn(),
    };
    const dropGraph = {
      add: vi.fn((node: { id: number }) => {
        node.id = 21;
      }),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => null),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 1, offset: [0, 0] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    (harness.windowObject as unknown as { LiteGraph?: unknown }).LiteGraph = {
      createNode: vi.fn(() => createdNode),
    };
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "drop-undeliverable", "drop-asset", {
      clientX: 10,
      clientY: 10,
      file: dropFile(),
      targets: [],
      create: { classType: "LoadImage", widget: "image" },
    });

    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "drop-undeliverable",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "drop-undeliverable",
      ),
    ).toMatchObject({ ok: false, error: { code: "drop-unsupported" } });
    expect(dropGraph.remove).toHaveBeenCalledWith(createdNode);
  });

  it("rejects drops onto memory loaders unless in-memory loading is disabled", async () => {
    const harness = createHarness();
    const memoryNode = {
      id: 3,
      type: "vloMemoryLoadImage",
      widgets: [
        { name: "image", value: "media-id-1" },
        { name: "disable_in_memory", value: false },
      ],
      setDirtyCanvas: vi.fn(),
    };
    const dropGraph = {
      add: vi.fn(),
      remove: vi.fn(),
      getNodeOnPos: vi.fn(() => memoryNode),
    };
    harness.app.canvas = {
      graph: dropGraph,
      ds: { scale: 1, offset: [0, 0] },
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    } as never;
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    const payload = {
      clientX: 50,
      clientY: 60,
      file: dropFile(),
      targets: [
        {
          classType: "vloMemoryLoadImage",
          widget: "image",
          requiresTruthyWidget: "disable_in_memory",
        },
      ],
      create: null,
    };
    request(harness, "drop-memory", "drop-asset", payload);

    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "drop-memory"),
      ).toBe(true),
    );
    expect(
      harness.posted.find((message) => message.requestId === "drop-memory"),
    ).toMatchObject({ ok: false, error: { code: "memory-loader-active" } });
    expect(memoryNode.widgets[0].value).toBe("media-id-1");

    // Disk mode ("true" string, as combo widgets serialize) accepts the drop.
    memoryNode.widgets[1].value = "true" as never;
    request(harness, "drop-memory-disabled", "drop-asset", payload);
    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "drop-memory-disabled",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "drop-memory-disabled",
      ),
    ).toMatchObject({
      ok: true,
      result: { action: "updated", nodeId: "3" },
    });
    expect(memoryNode.widgets[0].value).toBe("staged.png");
  });

  it("fingerprints node identity and topology rather than only node classes", () => {
    const first = {
      nodes: [
        { id: 1, type: "LoadImage" },
        { id: 2, type: "PreviewImage" },
      ],
      links: [[1, 1, 0, 2, 0, "IMAGE"]],
    };
    const second = {
      nodes: [
        { id: 1, type: "LoadImage" },
        { id: 2, type: "PreviewImage" },
      ],
      links: [],
    };
    expect(fingerprintWorkflow(first)).not.toBe(fingerprintWorkflow(second));

    // Load-stable identity: link representation, slot indexes, and link
    // types all drift when ComfyUI loads a workflow, so they must not
    // affect the fingerprint.
    const objectLinksWithDrift = {
      ...first,
      links: [
        { origin_id: 1, origin_slot: 3, target_id: 2, target_slot: 5, type: "MASK" },
      ],
    };
    expect(fingerprintWorkflow(objectLinksWithDrift)).toBe(
      fingerprintWorkflow(first),
    );

    const firstSubgraph = {
      ...first,
      definitions: {
        subgraphs: [{ nodes: [{ id: "nested-a", type: "KSampler" }], links: [] }],
      },
    };
    const secondSubgraph = {
      ...first,
      definitions: {
        subgraphs: [{ nodes: [{ id: "nested-b", type: "KSampler" }], links: [] }],
      },
    };
    expect(fingerprintWorkflow(firstSubgraph)).not.toBe(
      fingerprintWorkflow(secondSubgraph),
    );
  });
});
