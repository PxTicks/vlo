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
    extra: Record<string, unknown> = {};

    configure(serialized: {
      nodes: Array<Record<string, unknown>>;
      extra?: Record<string, unknown>;
    }) {
      this.extra = { ...(serialized.extra ?? {}) };
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
      const output =
        node?.mode === 4
          ? {}
          : {
              "node-a": {
                class_type: "LoadImage",
                inputs: { image: node?.widgets[0].value },
              },
            };
      return {
        output,
        workflow: { extra: { ...graph.extra } },
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
    expect(JSON.stringify(response)).not.toContain("__vloPromptGraphNonce");
  });

  it("fails closed and reports unresolved bypass node ids", async () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-missing-bypass", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "read-missing-bypass"),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-missing-bypass",
    )?.result as Record<string, unknown>;

    request(harness, "resolve-missing-bypass", "resolve-prompt", {
      ...snapshot,
      // An instance-scoped id whose enclosing instance does not exist: the
      // walk stops at the first segment the graph cannot resolve.
      bypassNodeIds: ["105:104", "105:104"],
      widgetOverrides: [],
    });
    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-missing-bypass",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "resolve-missing-bypass",
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          bypassNodeIds: [{ nodeId: "105:104", reason: "node-not-found" }],
          widgetOverrides: [],
        },
      },
    });
    expect(harness.app.graphToPrompt).not.toHaveBeenCalled();
    expect(harness.liveNode.mode).toBe(0);
  });

  it("fails closed and reports unresolved widget override targets", async () => {
    const harness = createHarness();
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-missing-widgets", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "read-missing-widgets"),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-missing-widgets",
    )?.result as Record<string, unknown>;

    request(harness, "resolve-missing-widgets", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: [],
      widgetOverrides: [
        { node_id: "missing-node", widget: "image", value: "override.png" },
        { node_id: "node-a", widget: "missing-widget", value: true },
      ],
    });
    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-missing-widgets",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "resolve-missing-widgets",
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          bypassNodeIds: [],
          widgetOverrides: [
            {
              index: 0,
              nodeId: "missing-node",
              widget: "image",
              reason: "node-not-found",
            },
            {
              index: 1,
              nodeId: "node-a",
              widget: "missing-widget",
              reason: "widget-not-found",
            },
          ],
        },
      },
    });
    expect(harness.app.graphToPrompt).not.toHaveBeenCalled();
    expect(harness.liveNode.widgets[0].value).toBe("live.png");
  });

  it("supports a Manager-style wrapper with ComfyUI's getter-only rootGraph", async () => {
    const harness = createHarness();
    const liveRootGraph = harness.app.rootGraph;
    const appPrototype = Object.create(Object.getPrototypeOf(harness.app), {
      rootGraph: {
        configurable: true,
        get: () => liveRootGraph,
      },
    });
    delete (harness.app as Partial<typeof harness.app>).rootGraph;
    Object.setPrototypeOf(harness.app, appPrototype);
    expect(Object.getOwnPropertyDescriptor(harness.app, "rootGraph")).toBeUndefined();

    harness.app.graphToPrompt.mockImplementationOnce(async () => {
      const graph = harness.app.rootGraph as unknown as {
        extra: Record<string, unknown>;
        getNodeById: (id: string) =>
          | {
              mode: number;
              widgets: Array<{ value: string | undefined }>;
            }
          | null;
      };
      const node = graph.getNodeById("node-a");
      return {
        output:
          node?.mode === 4
            ? {}
            : {
                "node-a": {
                  class_type: "LoadImage",
                  inputs: { image: node?.widgets[0].value },
                },
              },
        workflow: { extra: { ...graph.extra } },
      };
    });
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-ignored-graph", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "read-ignored-graph"),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-ignored-graph",
    )?.result as Record<string, unknown>;

    request(harness, "resolve-ignored-graph", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: ["node-a"],
      widgetOverrides: [],
    });
    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-ignored-graph",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "resolve-ignored-graph",
      ),
    ).toMatchObject({
      ok: true,
      result: { output: {} },
    });
    expect(harness.app.rootGraph).toBe(liveRootGraph);
    expect(Object.getOwnPropertyDescriptor(harness.app, "rootGraph")).toBeUndefined();
    expect(harness.liveNode.mode).toBe(0);
  });

  it("fails closed when a wrapper reads rootGraph after an asynchronous boundary", async () => {
    const harness = createHarness();
    const liveRootGraph = harness.app.rootGraph;
    harness.app.graphToPrompt.mockImplementationOnce(async () => {
      await Promise.resolve();
      return {
        output: {
          "node-a": {
            class_type: "LoadImage",
            inputs: { image: "live.png" },
          },
        },
        workflow: { extra: {} },
      };
    });
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-delayed-graph", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "read-delayed-graph"),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-delayed-graph",
    )?.result as Record<string, unknown>;

    request(harness, "resolve-delayed-graph", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: ["node-a"],
      widgetOverrides: [],
    });
    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-delayed-graph",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "resolve-delayed-graph",
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "graph-argument-ignored",
        details: {
          hint: expect.stringContaining("graphToPrompt wrappers"),
        },
      },
    });
    expect(harness.app.rootGraph).toBe(liveRootGraph);
    expect(harness.liveNode.mode).toBe(0);
  });

  it("restores rootGraph before an asynchronous graphToPrompt rejection", async () => {
    const harness = createHarness();
    const liveRootGraph = harness.app.rootGraph;
    let rejectResolution!: (error: Error) => void;
    harness.app.graphToPrompt.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          expect(harness.app.rootGraph).not.toBe(liveRootGraph);
          rejectResolution = reject;
        }),
    );
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-rejected-graph", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "read-rejected-graph"),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-rejected-graph",
    )?.result as Record<string, unknown>;

    request(harness, "resolve-rejected-graph", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: [],
      widgetOverrides: [],
    });
    await vi.waitFor(() => expect(rejectResolution).toBeTypeOf("function"));
    expect(harness.app.rootGraph).toBe(liveRootGraph);
    rejectResolution(new Error("wrapper failed"));

    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-rejected-graph",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "resolve-rejected-graph",
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "graph-to-prompt-failed",
        details: { reason: "wrapper failed" },
      },
    });
    expect(harness.app.rootGraph).toBe(liveRootGraph);
  });

  it("fails closed when graphToPrompt returns an applied bypass node", async () => {
    const harness = createHarness();
    harness.app.graphToPrompt.mockImplementationOnce(async (graph) => ({
      output: {
        "node-a": {
          class_type: "LoadImage",
          inputs: { image: "should-not-run.png" },
        },
      },
      workflow: { extra: { ...graph.extra } },
    }));
    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    hello(harness);
    request(harness, "read-leaked-bypass", "read-active");
    await vi.waitFor(() =>
      expect(
        harness.posted.some((message) => message.requestId === "read-leaked-bypass"),
      ).toBe(true),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read-leaked-bypass",
    )?.result as Record<string, unknown>;

    request(harness, "resolve-leaked-bypass", "resolve-prompt", {
      ...snapshot,
      bypassNodeIds: ["node-a"],
      widgetOverrides: [],
    });
    await vi.waitFor(() =>
      expect(
        harness.posted.some(
          (message) => message.requestId === "resolve-leaked-bypass",
        ),
      ).toBe(true),
    );
    expect(
      harness.posted.find(
        (message) => message.requestId === "resolve-leaked-bypass",
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "bypass-verification-failed",
        details: { nodeIds: ["node-a"] },
      },
    });
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
      (graph) =>
        new Promise((resolve) => {
          finishResolution = () =>
            resolve({
              output: {
                "node-a": {
                  class_type: "LoadImage",
                  inputs: { image: "live.png" },
                },
              },
              workflow: { extra: { ...graph.extra } },
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

// ---------------------------------------------------------------------------
// Scoped effect targets (docs/generation-native-extension-seams-plan.md N2b)
// ---------------------------------------------------------------------------

interface FakeWidget {
  name: string;
  value: unknown;
  /** Stands in for a custom widget whose setter rejects a value. */
  throwOnWrite?: boolean;
}

interface FakeNodeData {
  id: string;
  type: string;
  mode?: number;
  widgets?: FakeWidget[];
  /** Input slots. A non-null `link` means the widget of the same name is not
   * what executes — an upstream connection, or (inside a definition) a widget
   * promoted to the enclosing instance. */
  inputs?: Array<{ name: string; link: number | null }>;
  /** Definition id, when this node is a subgraph instance. */
  subgraphId?: string;
}

interface FakeGraphData {
  nodes: FakeNodeData[];
  definitions: Record<string, FakeNodeData[]>;
}

interface FakeRuntimeNode {
  id: string;
  type: string;
  mode: number;
  widgets: FakeWidget[];
  inputs: Array<{ name: string; link: number | null }>;
  subgraph?: FakeRuntimeGraph;
}

interface FakeRuntimeGraph {
  nodes: FakeRuntimeNode[];
  getNodeById(id: string | number): FakeRuntimeNode | null;
}

/**
 * Builds a litegraph-shaped runtime from serialized data.
 *
 * Two properties matter, and both are what make scoped targeting hard:
 *
 * - Every instance of a definition points at the *same* definition graph, so
 *   the inner node objects — and their `mode` and `widgets` — are shared
 *   between sibling instances, exactly as `SubgraphNode` shares
 *   `this.subgraph.nodes`.
 * - Widget *values* are read through `widgetStates`, keyed by node id and
 *   widget name. ComfyUI keys its widget store by (root graph id, node id,
 *   widget name), and a graph configured from a serialized clone inherits the
 *   live graph's id — so a clone's widget writes reach the live editor.
 */
function buildFakeRuntime(
  data: FakeGraphData,
  widgetStates: Map<string, { value: unknown }>,
): FakeRuntimeGraph {
  const definitionGraphs = new Map<string, FakeRuntimeGraph>();

  const makeGraph = (): FakeRuntimeGraph => {
    const graph: FakeRuntimeGraph = {
      nodes: [],
      getNodeById(id) {
        return (
          graph.nodes.find((node) => String(node.id) === String(id)) ?? null
        );
      },
    };
    return graph;
  };

  for (const definitionId of Object.keys(data.definitions)) {
    definitionGraphs.set(definitionId, makeGraph());
  }

  const bindWidget = (nodeId: string, widget: FakeWidget): FakeWidget => {
    const key = `${nodeId}.${widget.name}`;
    let state = widgetStates.get(key);
    if (!state) {
      state = { value: widget.value };
      widgetStates.set(key, state);
    }
    const bound = state;
    return {
      name: widget.name,
      get value() {
        return bound.value;
      },
      set value(next: unknown) {
        if (widget.throwOnWrite) {
          throw new Error(`widget ${widget.name} rejected ${String(next)}`);
        }
        bound.value = next;
      },
    };
  };

  const populate = (graph: FakeRuntimeGraph, nodes: FakeNodeData[]) => {
    for (const nodeData of nodes) {
      graph.nodes.push({
        id: nodeData.id,
        type: nodeData.type,
        mode: nodeData.mode ?? 0,
        widgets: (nodeData.widgets ?? []).map((widget) =>
          bindWidget(nodeData.id, widget),
        ),
        inputs: (nodeData.inputs ?? []).map((input) => ({ ...input })),
        ...(nodeData.subgraphId
          ? { subgraph: definitionGraphs.get(nodeData.subgraphId) }
          : {}),
      });
    }
  };

  for (const [definitionId, nodes] of Object.entries(data.definitions)) {
    populate(definitionGraphs.get(definitionId)!, nodes);
  }
  const root = makeGraph();
  populate(root, data.nodes);
  return root;
}

/** Expands subgraph instances the way `graphToPrompt` does: instance nodes are
 * virtual, inner nodes take `<instanceId>:<innerId>` ids. */
function fakeGraphToPrompt(graph: FakeRuntimeGraph) {
  const output: Record<string, unknown> = {};
  const walk = (current: FakeRuntimeGraph, prefix: string) => {
    for (const node of current.nodes) {
      if (node.mode === 2 || node.mode === 4) continue;
      if (node.subgraph) {
        walk(node.subgraph, `${prefix}${node.id}:`);
        continue;
      }
      output[`${prefix}${node.id}`] = {
        class_type: node.type,
        inputs: Object.fromEntries(
          node.widgets.map((widget) => [widget.name, widget.value]),
        ),
      };
    }
  };
  walk(graph, "");
  return output;
}

function subgraphFixture(): FakeGraphData {
  return {
    nodes: [
      { id: "1", type: "LoadImage", widgets: [{ name: "image", value: "root.png" }] },
      // Two instances of one definition: the inner loader is shared.
      { id: "10", type: "def-lora", subgraphId: "def-lora" },
      { id: "11", type: "def-lora", subgraphId: "def-lora" },
      // Single instance of a definition that only this node uses.
      { id: "12", type: "def-solo", subgraphId: "def-solo" },
      // Single instance whose inner loader promotes its strength widget.
      { id: "13", type: "def-promoted", subgraphId: "def-promoted" },
      // Nested: instance → instance → leaf.
      { id: "20", type: "def-outer", subgraphId: "def-outer" },
      // Root node whose widget was converted to a connected input.
      {
        id: "2",
        type: "KSampler",
        widgets: [{ name: "seed", value: 7 }],
        inputs: [{ name: "seed", link: 9 }],
      },
      // Root node carrying a custom widget whose setter rejects writes.
      {
        id: "3",
        type: "CustomNode",
        widgets: [{ name: "boom", value: "unset", throwOnWrite: true }],
      },
    ],
    definitions: {
      "def-lora": [
        {
          id: "5",
          type: "LoraLoaderModelOnly",
          widgets: [{ name: "strength_model", value: 1 }],
        },
      ],
      "def-solo": [
        {
          id: "6",
          type: "LoraLoaderModelOnly",
          widgets: [{ name: "strength_model", value: 0.5 }],
        },
      ],
      "def-promoted": [
        {
          id: "7",
          type: "LoraLoaderModelOnly",
          widgets: [{ name: "strength_model", value: 0.9 }],
          // Wired to the definition's input node: the value that executes is
          // the one held by instance 13, not this one.
          inputs: [{ name: "strength_model", link: 1 }],
        },
      ],
      "def-outer": [{ id: "30", type: "def-inner", subgraphId: "def-inner" }],
      "def-inner": [
        { id: "40", type: "KSampler", widgets: [{ name: "seed", value: 0 }] },
      ],
    },
  };
}

function createSubgraphHarness(data: FakeGraphData = subgraphFixture()) {
  const messageListeners = new Set<(event: RuntimeMessageEvent) => void>();
  const posted: Array<Record<string, unknown>> = [];
  const parent = {
    location: { origin: "http://vlo.test" },
    postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)),
  };
  const widgetStates = new Map<string, { value: unknown }>();
  const liveRuntime = buildFakeRuntime(data, widgetStates);
  const activeWorkflow = {
    filename: "subgraph-workflow",
    key: "subgraph-workflow.json",
    isModified: false,
    activeState: { nodes: data.nodes, links: [] },
    pendingWarnings: null,
  };

  class FakeLGraph implements FakeRuntimeGraph {
    nodes: FakeRuntimeNode[] = [];
    extra: Record<string, unknown> = {};

    configure(serialized: { extra?: Record<string, unknown> }) {
      this.extra = { ...(serialized.extra ?? {}) };
      // A real configure rebuilds every node from the serialized data: the
      // clone shares no node objects with the live graph, but its widgets
      // resolve back to the same widget state.
      this.nodes = buildFakeRuntime(data, widgetStates).nodes;
    }

    getNodeById(id: string | number) {
      return this.nodes.find((node) => String(node.id) === String(id)) ?? null;
    }
  }

  const app = {
    canvas: {},
    rootGraph: {
      serialize: vi.fn(() => ({ nodes: [], links: [] })),
    },
    extensionManager: {
      spinner: false,
      workflow: {
        activeWorkflow,
        openWorkflows: [activeWorkflow],
        closeWorkflow: vi.fn(),
      },
    },
    handleFile: vi.fn(),
    graphToPrompt: vi.fn(async (graph: FakeLGraph) => ({
      output: fakeGraphToPrompt(graph),
      workflow: { extra: { ...graph.extra } },
    })),
  };
  const api = {
    clientId: "iframe-client-subgraph",
    socket: { readyState: 1, OPEN: 1 },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const windowObject = {
    parent,
    location: { origin: "http://vlo.test" },
    crypto: { randomUUID: () => "workflow-instance" },
    structuredClone,
    LGraph: FakeLGraph,
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(
      (name: string, handler: (event: RuntimeMessageEvent) => void) => {
        if (name === "message") messageListeners.add(handler);
      },
    ),
    removeEventListener: vi.fn(),
  };

  function send(data: Record<string, unknown>) {
    for (const listener of messageListeners) {
      listener({ source: parent, origin: "http://vlo.test", data });
    }
  }

  return { app, api, liveRuntime, posted, send, windowObject };
}

type SubgraphHarness = ReturnType<typeof createSubgraphHarness>;

async function resolveScopedPrompt(
  harness: SubgraphHarness,
  requestId: string,
  effects: {
    bypassNodeIds?: string[];
    widgetOverrides?: Array<{ node_id: string; widget: string; value: unknown }>;
  },
) {
  startVloBridge({
    app: harness.app,
    api: harness.api,
    windowObject: harness.windowObject,
  });
  const envelope = {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    channelId: "channel-1",
  };
  harness.send({ ...envelope, type: "hello" });
  harness.send({
    ...envelope,
    type: "request",
    requestId: `${requestId}-read`,
    method: "read-active",
  });
  await vi.waitFor(() =>
    expect(
      harness.posted.some((message) => message.requestId === `${requestId}-read`),
    ).toBe(true),
  );
  const snapshot = harness.posted.find(
    (message) => message.requestId === `${requestId}-read`,
  )?.result as Record<string, unknown>;

  harness.send({
    ...envelope,
    type: "request",
    requestId,
    method: "resolve-prompt",
    payload: {
      ...snapshot,
      bypassNodeIds: effects.bypassNodeIds ?? [],
      widgetOverrides: effects.widgetOverrides ?? [],
    },
  });
  await vi.waitFor(() =>
    expect(harness.posted.some((message) => message.requestId === requestId)).toBe(
      true,
    ),
  );
  return harness.posted.find((message) => message.requestId === requestId) as
    | Record<string, unknown>
    | undefined;
}

/** The live definition node an execution id addresses, for asserting that
 * prompt resolution left the editor graph alone. */
function liveNodeAt(harness: SubgraphHarness, executionId: string) {
  let graph: FakeRuntimeGraph | undefined = harness.liveRuntime;
  let node: FakeRuntimeNode | null = null;
  for (const segment of executionId.split(":")) {
    node = graph?.getNodeById(segment) ?? null;
    graph = node?.subgraph;
  }
  return node;
}

describe("scoped effect targets on the temporary graph", () => {
  it("writes a widget inside a uniquely instantiated subgraph", async () => {
    const harness = createSubgraphHarness();
    const response = await resolveScopedPrompt(harness, "scoped-widget", {
      widgetOverrides: [
        { node_id: "12:6", widget: "strength_model", value: 0.25 },
      ],
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        output: {
          "12:6": { inputs: { strength_model: 0.25 } },
        },
      },
    });
    expect(liveNodeAt(harness, "12:6")?.widgets[0].value).toBe(0.5);
  });

  it("writes a widget inside a nested subgraph instance", async () => {
    const harness = createSubgraphHarness();
    const response = await resolveScopedPrompt(harness, "nested-widget", {
      widgetOverrides: [{ node_id: "20:30:40", widget: "seed", value: 42 }],
    });

    expect(response).toMatchObject({
      ok: true,
      result: { output: { "20:30:40": { inputs: { seed: 42 } } } },
    });
    expect(liveNodeAt(harness, "20:30:40")?.widgets[0].value).toBe(0);
  });

  it("bypasses a node inside a subgraph instance and verifies the prompt", async () => {
    const harness = createSubgraphHarness();
    const response = await resolveScopedPrompt(harness, "scoped-bypass", {
      bypassNodeIds: ["12:6"],
    });

    const output = (response?.result as { output: Record<string, unknown> })
      .output;
    expect(response).toMatchObject({ ok: true });
    expect(output).not.toHaveProperty("12:6");
    expect(output).toHaveProperty("20:30:40");
    expect(liveNodeAt(harness, "12:6")?.mode).toBe(0);
  });

  it("bypasses a whole subgraph instance and rejects any inner node that survives", async () => {
    const harness = createSubgraphHarness();
    const clean = await resolveScopedPrompt(harness, "instance-bypass", {
      bypassNodeIds: ["20"],
    });
    expect(clean).toMatchObject({ ok: true });
    expect(
      (clean?.result as { output: Record<string, unknown> }).output,
    ).not.toHaveProperty("20:30:40");

    // ComfyUI's inner-node walk does not re-check mode below the root, so a
    // nested instance can still emit prompt nodes under a bypassed ancestor.
    const leaky = createSubgraphHarness();
    leaky.app.graphToPrompt.mockImplementationOnce(async (graph) => ({
      output: {
        ...fakeGraphToPrompt(graph),
        "20:30:40": { class_type: "KSampler", inputs: { seed: 0 } },
      },
      workflow: { extra: { ...graph.extra } },
    }));
    const response = await resolveScopedPrompt(leaky, "leaky-bypass", {
      bypassNodeIds: ["20"],
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "bypass-verification-failed", details: { nodeIds: ["20"] } },
    });
  });

  it("fails closed rather than letting a sibling instance inherit the write", async () => {
    const harness = createSubgraphHarness();
    const response = await resolveScopedPrompt(harness, "shared-widget", {
      widgetOverrides: [
        { node_id: "10:5", widget: "strength_model", value: 0.75 },
      ],
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          widgetOverrides: [
            {
              index: 0,
              nodeId: "10:5",
              widget: "strength_model",
              reason: "shared-subgraph-instance",
            },
          ],
        },
      },
    });
    expect(harness.app.graphToPrompt).not.toHaveBeenCalled();
    expect(liveNodeAt(harness, "10:5")?.widgets[0].value).toBe(1);
    expect(liveNodeAt(harness, "11:5")?.widgets[0].value).toBe(1);
  });

  it("rejects a scoped id whose enclosing node is not a subgraph instance", async () => {
    const harness = createSubgraphHarness();
    const response = await resolveScopedPrompt(harness, "not-an-instance", {
      bypassNodeIds: ["1:5"],
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          bypassNodeIds: [{ nodeId: "1:5", reason: "not-a-subgraph-instance" }],
        },
      },
    });
    expect(harness.app.graphToPrompt).not.toHaveBeenCalled();
  });

  it("rejects a scoped id whose inner node does not exist", async () => {
    const harness = createSubgraphHarness();
    const response = await resolveScopedPrompt(harness, "missing-inner", {
      widgetOverrides: [{ node_id: "12:99", widget: "strength_model", value: 1 }],
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          widgetOverrides: [{ nodeId: "12:99", reason: "node-not-found" }],
        },
      },
    });
  });

  it("rejects a widget write that the resolved prompt would not use", async () => {
    const harness = createSubgraphHarness();
    const promoted = await resolveScopedPrompt(harness, "promoted-widget", {
      widgetOverrides: [
        { node_id: "13:7", widget: "strength_model", value: 0.1 },
      ],
    });

    // The inner node's widget is wired to the definition's input node, so the
    // enclosing instance's promoted value is what executes. Writing the inner
    // widget would report success while submitting the old value.
    expect(promoted).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          widgetOverrides: [
            {
              index: 0,
              nodeId: "13:7",
              widget: "strength_model",
              reason: "widget-not-executed",
            },
          ],
        },
      },
    });
    expect(harness.app.graphToPrompt).not.toHaveBeenCalled();

    // Same rule at the root: a widget converted to a connected input loses to
    // its upstream link.
    const rootHarness = createSubgraphHarness();
    const linked = await resolveScopedPrompt(rootHarness, "linked-widget", {
      widgetOverrides: [{ node_id: "2", widget: "seed", value: 123 }],
    });
    expect(linked).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          widgetOverrides: [{ nodeId: "2", reason: "widget-not-executed" }],
        },
      },
    });
  });

  it("serializes overlapping resolutions so neither strands an override", async () => {
    const harness = createSubgraphHarness();
    const pending: Array<() => void> = [];
    harness.app.graphToPrompt.mockImplementation(
      (graph) =>
        new Promise((resolve) => {
          const output = fakeGraphToPrompt(graph);
          pending.push(() =>
            resolve({ output, workflow: { extra: { ...graph.extra } } }),
          );
        }),
    );

    startVloBridge({
      app: harness.app,
      api: harness.api,
      windowObject: harness.windowObject,
    });
    const envelope = {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      channelId: "channel-1",
    };
    harness.send({ ...envelope, type: "hello" });
    harness.send({
      ...envelope,
      type: "request",
      requestId: "read",
      method: "read-active",
    });
    await vi.waitFor(() =>
      expect(harness.posted.some((message) => message.requestId === "read")).toBe(
        true,
      ),
    );
    const snapshot = harness.posted.find(
      (message) => message.requestId === "read",
    )?.result as Record<string, unknown>;

    const send = (requestId: string, value: number) =>
      harness.send({
        ...envelope,
        type: "request",
        requestId,
        method: "resolve-prompt",
        payload: {
          ...snapshot,
          bypassNodeIds: [],
          widgetOverrides: [
            { node_id: "12:6", widget: "strength_model", value },
          ],
        },
      });

    send("concurrent-a", 0.25);
    send("concurrent-b", 0.75);

    // The second resolution must not start while the first holds the live
    // widget state; otherwise it captures the first request's override as the
    // value to restore.
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(harness.app.graphToPrompt).toHaveBeenCalledTimes(1);
    pending[0]();

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]();
    await vi.waitFor(() =>
      expect(
        harness.posted.filter((message) => message.requestId === "concurrent-b"),
      ).toHaveLength(1),
    );

    expect(
      harness.posted.find((message) => message.requestId === "concurrent-a"),
    ).toMatchObject({
      ok: true,
      result: { output: { "12:6": { inputs: { strength_model: 0.25 } } } },
    });
    expect(
      harness.posted.find((message) => message.requestId === "concurrent-b"),
    ).toMatchObject({
      ok: true,
      result: { output: { "12:6": { inputs: { strength_model: 0.75 } } } },
    });
    expect(liveNodeAt(harness, "12:6")?.widgets[0].value).toBe(0.5);
  });

  it("keeps a live editor edit made while resolution was pending", async () => {
    const harness = createSubgraphHarness();
    harness.app.graphToPrompt.mockImplementationOnce(async (graph) => {
      const output = fakeGraphToPrompt(graph);
      // The user drags the same slider in the editor while graphToPrompt is
      // awaited. They now own the widget; the resolution must not put its own
      // pre-override value back over their edit.
      liveNodeAt(harness, "12:6")!.widgets[0].value = 0.8;
      return { output, workflow: { extra: { ...graph.extra } } };
    });

    const response = await resolveScopedPrompt(harness, "live-edit", {
      widgetOverrides: [
        { node_id: "12:6", widget: "strength_model", value: 0.25 },
      ],
    });

    expect(response).toMatchObject({
      ok: true,
      result: { output: { "12:6": { inputs: { strength_model: 0.25 } } } },
    });
    expect(liveNodeAt(harness, "12:6")?.widgets[0].value).toBe(0.8);
  });

  it("restores earlier overrides when a widget setter throws", async () => {
    const harness = createSubgraphHarness();
    const response = await resolveScopedPrompt(harness, "setter-throws", {
      widgetOverrides: [
        { node_id: "12:6", widget: "strength_model", value: 0.25 },
        { node_id: "3", widget: "boom", value: "nope" },
      ],
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "graph-override-apply-failed" },
    });
    expect(harness.app.graphToPrompt).not.toHaveBeenCalled();
    // The first override was already installed on shared widget state when the
    // second threw; nothing may outlive the failed resolution.
    expect(liveNodeAt(harness, "12:6")?.widgets[0].value).toBe(0.5);
    expect(liveNodeAt(harness, "3")?.widgets[0].value).toBe("unset");
  });

  it("restores overridden widget values after resolution", async () => {
    const harness = createSubgraphHarness();
    let observedDuringResolution: unknown;
    harness.app.graphToPrompt.mockImplementationOnce(async (graph) => {
      observedDuringResolution = graph
        .getNodeById("12")
        ?.subgraph?.getNodeById("6")?.widgets[0].value;
      return {
        output: fakeGraphToPrompt(graph),
        workflow: { extra: { ...graph.extra } },
      };
    });

    await resolveScopedPrompt(harness, "restore-widget", {
      widgetOverrides: [
        { node_id: "12:6", widget: "strength_model", value: 0.25 },
      ],
    });

    // The override is what ComfyUI serialized, and nothing outlives the call:
    // widget state is keyed by (root graph id, node id, widget name), and the
    // clone inherits the live graph's id.
    expect(observedDuringResolution).toBe(0.25);
    expect(liveNodeAt(harness, "12:6")?.widgets[0].value).toBe(0.5);
  });
});
