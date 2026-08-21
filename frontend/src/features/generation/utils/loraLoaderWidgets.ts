import type {
  GenerationNodeSnapshot,
  GenerationWidgetSnapshot,
} from "../services/generationSessionTypes";
import type { WorkflowRules } from "../services/workflowRules";
import type { WorkflowWidgetInput } from "../types";
import { getNodeBypassWidgetKey } from "./nodeBypassWidgets";

const BYPASS_MODE = 4;

const EMPTY_NODE_IDS: ReadonlySet<string> = new Set<string>();

export const LORA_BYPASS_CHOICE = "vlo.lora-loader:none";
export const LORA_LOADERS_SECTION_ID = "lora_loaders";
export const LORA_MODEL_WIDGET = "lora_name";

function isLoraLoaderClass(classType: string): boolean {
  return classType.toLowerCase().startsWith("loraloader");
}

function findModelWidget(
  node: GenerationNodeSnapshot,
): GenerationWidgetSnapshot | null {
  const widget = node.widgets.find(
    (candidate) => candidate.param === LORA_MODEL_WIDGET,
  );
  if (!widget || widget.linked || !widget.options) return null;
  return widget.options.some((option) => typeof option === "string")
    ? widget
    : null;
}

/** Read discovery opt-ins before the corresponding widgets are resolved. */
export function collectBypassDiscoveryNodeIds(
  rules: WorkflowRules | null | undefined,
): ReadonlySet<string> {
  const nodeIds = new Set<string>();
  for (const [nodeId, nodeRule] of Object.entries(rules?.nodes ?? {})) {
    if (nodeRule.ignore) continue;
    for (const entry of Object.values(nodeRule.widgets ?? {})) {
      if (entry.discover_when_bypassed === true) {
        nodeIds.add(nodeId);
        break;
      }
    }
  }
  return nodeIds;
}

function toLoraWidgetInput(
  node: GenerationNodeSnapshot,
  bypassDiscoveryNodeIds: ReadonlySet<string>,
): WorkflowWidgetInput | null {
  // Muted nodes drop their outputs and cannot be made usable here.
  const shipsBypassed = node.mode === BYPASS_MODE;
  const discoverable =
    node.mode === 0 || (shipsBypassed && bypassDiscoveryNodeIds.has(node.id));
  if (!discoverable || !isLoraLoaderClass(node.classType)) return null;
  const widget = findModelWidget(node);
  if (!widget) return null;

  const options = widget.options?.filter(
    (option): option is string => typeof option === "string",
  ) ?? [];
  if (options.length === 0 || options.includes(LORA_BYPASS_CHOICE)) return null;
  const currentValue = widget.value ?? widget.defaultValue ?? null;

  return {
    nodeId: node.id,
    param: widget.param,
    currentValue,
    config: {
      label: "Model",
      controlAfterGenerate: false,
      valueType: "enum",
      options,
      defaultValue: widget.defaultValue,
      sectionId: LORA_LOADERS_SECTION_ID,
      groupId: `lora-loader:${node.id}`,
      groupTitle: node.title || node.classType,
      nodeTitle: node.title || node.classType,
      nodeBypassOption: {
        value: LORA_BYPASS_CHOICE,
        label: "None (bypass)",
      },
      // Ignore the stored model name until the user turns this loader on.
      ...(shipsBypassed
        ? {
            nodeShipsBypassed: true,
            defaultNodeBypass: true,
            discoverWhenBypassed: true,
          }
        : {}),
    },
  };
}

/**
 * Discover active root and instantiated-subgraph LoRA loaders from the same
 * immutable catalogue used by the generation session.
 */
export function resolveAutodiscoveredLoraWidgetInputs(
  nodes: readonly GenerationNodeSnapshot[],
  bypassDiscoveryNodeIds: ReadonlySet<string> = EMPTY_NODE_IDS,
): readonly WorkflowWidgetInput[] {
  return nodes.flatMap((node) => {
    const input = toLoraWidgetInput(node, bypassDiscoveryNodeIds);
    return input ? [input] : [];
  });
}

/** Report discovery opt-ins that no longer target a bypassed node. */
export function collectBypassDiscoveryDiagnostics(
  nodes: readonly GenerationNodeSnapshot[],
  bypassDiscoveryNodeIds: ReadonlySet<string>,
): readonly string[] {
  if (bypassDiscoveryNodeIds.size === 0) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const diagnostics: string[] = [];
  for (const nodeId of bypassDiscoveryNodeIds) {
    const node = byId.get(nodeId);
    if (!node) continue;
    if (node.mode === BYPASS_MODE) continue;
    diagnostics.push(
      node.mode === 0
        ? `Node ${nodeId} (${node.title || node.classType}) sets discover_when_bypassed, but ships active — ` +
            "its model will still be reported missing. Re-save the workflow with the node bypassed."
        : `Node ${nodeId} (${node.title || node.classType}) sets discover_when_bypassed, but ships with mode ` +
            `${node.mode}; only bypassed (4) nodes can be turned on from the panel.`,
    );
  }
  return diagnostics;
}

/**
 * Add missing loaders and enhance explicitly presented loader widgets in
 * place, so sidecar ordering and labels continue to win over autodiscovery.
 */
export function mergeAutodiscoveredLoraWidgetInputs(
  widgetInputs: readonly WorkflowWidgetInput[],
  autodiscovered: readonly WorkflowWidgetInput[],
): WorkflowWidgetInput[] {
  const byTarget = new Map(
    autodiscovered.map((widget) => [
      getNodeBypassWidgetKey(widget.nodeId, widget.param),
      widget,
    ]),
  );
  const merged = widgetInputs.map((widget) => {
    const key = getNodeBypassWidgetKey(widget.nodeId, widget.param);
    const discovered = byTarget.get(key);
    if (!discovered) return widget;
    byTarget.delete(key);
    // Sidecars own presentation, but cannot remove the native safety choice:
    // every autodiscovered LoRA loader remains bypassable in the panel.
    //
    // The enum itself is inherited rather than owned: the installed LoRA files
    // are runtime data from object_info, so an author cannot state `options`
    // correctly and a sidecar that declares the widget only to label it — or
    // to set `default_node_bypass` — must not downgrade the dropdown to a
    // free-text box. A sidecar that does state them still wins.
    return {
      ...widget,
      config: {
        ...widget.config,
        valueType: widget.config.valueType ?? discovered.config.valueType,
        options: widget.config.options ?? discovered.config.options,
        nodeBypassOption: discovered.config.nodeBypassOption,
        // Not presentation: which way the submission has to move the node is
        // a fact about the workflow file, so a sidecar cannot override it.
        nodeShipsBypassed: discovered.config.nodeShipsBypassed,
        defaultNodeBypass:
          discovered.config.defaultNodeBypass ?? widget.config.defaultNodeBypass,
      },
    };
  });
  return [...merged, ...byTarget.values()];
}
