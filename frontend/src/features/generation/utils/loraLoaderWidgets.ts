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
export const LORA_MODEL_STRENGTH_WIDGET = "strength_model";
export const LORA_CLIP_STRENGTH_WIDGET = "strength_clip";

/** Strength params in the slot order the loader classes declare them. */
const LORA_STRENGTH_WIDGETS: readonly string[] = [
  LORA_MODEL_STRENGTH_WIDGET,
  LORA_CLIP_STRENGTH_WIDGET,
];

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

function findStrengthWidgets(
  node: GenerationNodeSnapshot,
): readonly GenerationWidgetSnapshot[] {
  return LORA_STRENGTH_WIDGETS.flatMap((param) => {
    const widget = node.widgets.find((candidate) => candidate.param === param);
    // An enum-typed `strength_*` is not this loader's weight, whatever the
    // class calls it, so it stays out of the panel rather than rendering as a
    // number field over values it cannot represent.
    if (!widget || widget.linked || widget.options) return [];
    return widget.valueType === "float" || widget.valueType === "int"
      ? [widget]
      : [];
  });
}

/**
 * A loader carrying both weights labels them apart; the model-only classes,
 * which are the common case, get the unqualified word.
 */
function resolveStrengthLabel(
  param: string,
  strengthWidgets: readonly GenerationWidgetSnapshot[],
): string {
  if (strengthWidgets.length < 2) return "Strength";
  return param === LORA_CLIP_STRENGTH_WIDGET
    ? "CLIP strength"
    : "Model strength";
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

function toLoraWidgetInputs(
  node: GenerationNodeSnapshot,
  bypassDiscoveryNodeIds: ReadonlySet<string>,
): readonly WorkflowWidgetInput[] {
  // Muted nodes drop their outputs and cannot be made usable here.
  const shipsBypassed = node.mode === BYPASS_MODE;
  const discoverable =
    node.mode === 0 || (shipsBypassed && bypassDiscoveryNodeIds.has(node.id));
  if (!discoverable || !isLoraLoaderClass(node.classType)) return [];
  const widget = findModelWidget(node);
  if (!widget) return [];

  const options = widget.options?.filter(
    (option): option is string => typeof option === "string",
  ) ?? [];
  if (options.length === 0 || options.includes(LORA_BYPASS_CHOICE)) return [];
  const currentValue = widget.value ?? widget.defaultValue ?? null;
  const title = node.title || node.classType;
  const groupId = `lora-loader:${node.id}`;

  const modelWidget: WorkflowWidgetInput = {
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
      groupId,
      groupTitle: title,
      nodeTitle: title,
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

  // The weight belongs to the same loader, so it rides the model widget's
  // placement: whichever group the dropdown lands in, its strengths follow.
  const strengthWidgets = findStrengthWidgets(node);
  return [
    modelWidget,
    ...strengthWidgets.map((strength) => ({
      nodeId: node.id,
      param: strength.param,
      currentValue: strength.value ?? strength.defaultValue ?? null,
      config: {
        label: resolveStrengthLabel(strength.param, strengthWidgets),
        controlAfterGenerate: false,
        valueType: strength.valueType,
        defaultValue: strength.defaultValue ?? undefined,
        ...(strength.min === null ? {} : { min: strength.min }),
        ...(strength.max === null ? {} : { max: strength.max }),
        ...(strength.step === null ? {} : { step: strength.step }),
        sectionId: LORA_LOADERS_SECTION_ID,
        groupId,
        groupTitle: title,
        nodeTitle: title,
      },
    })),
  ];
}

/**
 * Discover active root and instantiated-subgraph LoRA loaders from the same
 * immutable catalogue used by the generation session.
 */
export function resolveAutodiscoveredLoraWidgetInputs(
  nodes: readonly GenerationNodeSnapshot[],
  bypassDiscoveryNodeIds: ReadonlySet<string> = EMPTY_NODE_IDS,
): readonly WorkflowWidgetInput[] {
  return nodes.flatMap((node) =>
    toLoraWidgetInputs(node, bypassDiscoveryNodeIds),
  );
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
  // Where a sidecar presents the dropdown itself it also decides where the
  // loader lives, so the strengths it did not declare are re-homed onto that
  // group instead of opening a second one in the LoRA section.
  const presentedModelWidgets = new Map(
    widgetInputs.flatMap((widget) =>
      widget.param === LORA_MODEL_WIDGET
        ? [[widget.nodeId, widget] as const]
        : [],
    ),
  );
  const merged = widgetInputs.map((widget) => {
    const key = getNodeBypassWidgetKey(widget.nodeId, widget.param);
    const discovered = byTarget.get(key);
    if (!discovered) return widget;
    byTarget.delete(key);
    // Only the model dropdown carries the bypass choice and the runtime enum;
    // a sidecar-presented strength keeps exactly what its author wrote.
    if (widget.param !== LORA_MODEL_WIDGET) return widget;
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
  const appended = [...byTarget.values()].map((widget) => {
    const presented =
      widget.param === LORA_MODEL_WIDGET
        ? undefined
        : presentedModelWidgets.get(widget.nodeId);
    if (!presented) return widget;
    return {
      ...widget,
      config: {
        ...widget.config,
        // Taken verbatim, undefined included: an author who declared no
        // section put the loader in the panel's default one, and the weight
        // has to land in the same place rather than back in the LoRA section.
        sectionId: presented.config.sectionId,
        // The panel groups an undeclared `group_id` under the node id, so an
        // author who stated neither still gets one group, not two.
        groupId: presented.config.groupId ?? presented.nodeId,
        groupTitle: presented.config.groupTitle ?? widget.config.groupTitle,
        // A hidden dropdown means the author kept this loader out of the
        // panel; its weight must not reintroduce it.
        hidden: presented.config.hidden,
      },
    };
  });
  return [...merged, ...appended];
}
