import { expect, vi } from "vitest";
import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  startVloBridge,
} from "../../../backend/assets/comfyui_bridge/bridge-core.mjs";

/**
 * A litegraph-shaped ComfyUI stand-in for scoped effect targets
 * (docs/generation-native-extension-seams-plan.md N2b).
 *
 * Shared between the bridge's own runtime suite and the LoRA-policy
 * conformance fixture, which needs the same graph semantics to prove that an
 * extension contribution reaches exactly one subgraph instance. Both suites
 * assert against the real `bridge-core.mjs`; only the fake ComfyUI around it
 * lives here.
 */

interface RuntimeMessageEvent {
  source: unknown;
  origin: string;
  data: Record<string, unknown>;
}

export interface FakeWidget {
  name: string;
  value: unknown;
  /** Stands in for a custom widget whose setter rejects a value. */
  throwOnWrite?: boolean;
}

export interface FakeNodeData {
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

export interface FakeGraphData {
  nodes: FakeNodeData[];
  definitions: Record<string, FakeNodeData[]>;
}

export interface FakeRuntimeNode {
  id: string;
  type: string;
  mode: number;
  widgets: FakeWidget[];
  inputs: Array<{ name: string; link: number | null }>;
  subgraph?: FakeRuntimeGraph;
}

export interface FakeRuntimeGraph {
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
export function buildFakeRuntime(
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
export function fakeGraphToPrompt(graph: FakeRuntimeGraph) {
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

export function subgraphFixture(): FakeGraphData {
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

export function createSubgraphHarness(data: FakeGraphData = subgraphFixture()) {
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

export type SubgraphHarness = ReturnType<typeof createSubgraphHarness>;

export async function resolveScopedPrompt(
  harness: SubgraphHarness,
  requestId: string,
  effects: {
    bypassNodeIds?: readonly string[];
    activateNodeIds?: readonly string[];
    // `value` is optional to match the pipeline's own `WidgetOverride`, so a
    // built bridge payload can be passed straight through.
    widgetOverrides?: ReadonlyArray<{
      node_id: string;
      widget: string;
      value?: unknown;
    }>;
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
      activateNodeIds: effects.activateNodeIds ?? [],
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
export function liveNodeAt(harness: SubgraphHarness, executionId: string) {
  let graph: FakeRuntimeGraph | undefined = harness.liveRuntime;
  let node: FakeRuntimeNode | null = null;
  for (const segment of executionId.split(":")) {
    node = graph?.getNodeById(segment) ?? null;
    graph = node?.subgraph;
  }
  return node;
}
