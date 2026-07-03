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
