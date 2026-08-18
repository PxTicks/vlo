import type {
  GenerationNodeSnapshot,
  GenerationWidgetSnapshot,
} from "../services/generationSessionTypes";
import type { WorkflowWidgetInput } from "../types";
import { getNodeBypassWidgetKey } from "./nodeBypassWidgets";

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

function toLoraWidgetInput(
  node: GenerationNodeSnapshot,
): WorkflowWidgetInput | null {
  if (node.mode !== 0 || !isLoraLoaderClass(node.classType)) return null;
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
    },
  };
}

/**
 * Discover active root and instantiated-subgraph LoRA loaders from the same
 * immutable catalogue used by the generation session.
 */
export function resolveAutodiscoveredLoraWidgetInputs(
  nodes: readonly GenerationNodeSnapshot[],
): readonly WorkflowWidgetInput[] {
  return nodes.flatMap((node) => {
    const input = toLoraWidgetInput(node);
    return input ? [input] : [];
  });
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
      },
    };
  });
  return [...merged, ...byTarget.values()];
}
