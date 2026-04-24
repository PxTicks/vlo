/**
 * Pre-resolve a ComfyUI prompt by mutating the live LiteGraph graph
 * in-place, calling graphToPrompt, then reverting all mutations.
 *
 * This is the core transaction that replaces backend graph rewriting with
 * in-browser ComfyUI resolution. The mutation window is invisible to the
 * user because we never set the dirty-canvas flag between mutate and revert.
 */

import type { WidgetOverride } from "./evaluateRewrites";

// Module-scoped guard — checked by ComfyUIEditor polling to avoid
// committing a half-mutated graph back to the server.
let graphMutationInFlight = false;

export function isGraphMutationInFlight(): boolean {
  return graphMutationInFlight;
}

interface LiteGraphWidget {
  name: string;
  value: unknown;
  callback?: (
    value: unknown,
    canvas: unknown,
    node: unknown,
    pos: unknown,
    event: unknown,
  ) => void;
}

interface LiteGraphNode {
  id: number;
  mode: number;
  widgets?: LiteGraphWidget[];
}

interface LiteGraphGraph {
  getNodeById(id: number): LiteGraphNode | null;
  setDirtyCanvas(fg: boolean, bg: boolean): void;
}

interface ComfyApp {
  graph: LiteGraphGraph;
  graphToPrompt(): Promise<{
    output: Record<string, unknown>;
    workflow: Record<string, unknown>;
  }>;
}

export interface PreResolveResult {
  output: Record<string, unknown>;
  workflow: Record<string, unknown>;
}

/**
 * Mutate the live LiteGraph graph, call graphToPrompt, then revert.
 *
 * @param iframe   The ComfyUI iframe element
 * @param bypassNodeIds   Node IDs to set `mode: 4` on
 * @param widgetOverrides   Widget values to set before resolving
 * @returns The resolved prompt output + workflow, or null on failure
 */
export async function preResolvePrompt(
  iframe: HTMLIFrameElement,
  bypassNodeIds: string[],
  widgetOverrides: WidgetOverride[],
): Promise<PreResolveResult | null> {
  const win = iframe.contentWindow as (Window & { app?: ComfyApp }) | null;
  const app = win?.app;
  if (!app?.graph || typeof app.graphToPrompt !== "function") {
    console.warn("[preResolvePrompt] app.graph or graphToPrompt not available");
    return null;
  }

  const reverts: Array<() => void> = [];
  graphMutationInFlight = true;

  try {
    // 1. Bypass nodes
    for (const nodeIdStr of bypassNodeIds) {
      const nodeId = Number(nodeIdStr);
      const node = app.graph.getNodeById(nodeId);
      if (!node) continue;

      const oldMode = node.mode;
      node.mode = 4; // ComfyUI bypass mode
      reverts.push(() => {
        node.mode = oldMode;
      });
    }

    // 2. Set widget values
    for (const override of widgetOverrides) {
      const nodeId = Number(override.node_id);
      const node = app.graph.getNodeById(nodeId);
      if (!node) continue;

      const widget = node.widgets?.find(
        (w: LiteGraphWidget) => w.name === override.widget,
      );
      if (!widget) continue;

      const oldValue = widget.value;
      widget.value = override.value;
      reverts.push(() => {
        widget.value = oldValue;
      });
    }

    // 3. Resolve the prompt
    const result = await app.graphToPrompt();

    return {
      output: result.output as Record<string, unknown>,
      workflow: result.workflow as Record<string, unknown>,
    };
  } catch (err) {
    console.error("[preResolvePrompt] graphToPrompt failed:", err);
    return null;
  } finally {
    // 4. Revert all mutations in reverse order
    reverts.reverse().forEach((fn) => fn());

    // 5. Single dirty-canvas call after revert (not between mutate and revert)
    try {
      app.graph.setDirtyCanvas(true, true);
    } catch {
      // setDirtyCanvas is best-effort
    }

    graphMutationInFlight = false;
  }
}
