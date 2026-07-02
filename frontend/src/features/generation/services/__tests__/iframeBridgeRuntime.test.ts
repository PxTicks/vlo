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
  const apiListeners = new Map<string, Set<() => void>>();
  const posted: Array<Record<string, unknown>> = [];
  const parent = {
    location: { origin: "http://vlo.test" },
    postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)),
  };
  const activeWorkflow = {
    filename: "workflow.json",
    isModified: false,
    activeState: {
      nodes: [{ id: "node-a", type: "LoadImage" }],
      links: [],
    },
    pendingWarnings: null,
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
        workflows: [activeWorkflow],
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
    socket: { readyState: 1, OPEN: 1 },
    addEventListener: vi.fn((name: string, handler: () => void) => {
      const handlers = apiListeners.get(name) ?? new Set();
      handlers.add(handler);
      apiListeners.set(name, handlers);
    }),
    removeEventListener: vi.fn(),
  };
  const windowObject = {
    parent,
    location: { origin: "http://vlo.test" },
    crypto: { randomUUID: () => "workflow-instance" },
    structuredClone,
    LGraph: FakeLGraph,
    Blob,
    File,
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

  function emitApi(name: string) {
    for (const listener of apiListeners.get(name) ?? []) listener();
  }

  return {
    activeWorkflow,
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
  it("announces the complete v2 contract only to its same-origin parent", () => {
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
    });
  });

  it("injects the exact workflow and returns parsed warnings", async () => {
    const harness = createHarness();
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
      graphData: harness.activeWorkflow.activeState,
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
          filename: "workflow.json",
          workflowInstanceId: "workflow-instance",
        },
      },
    });
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
