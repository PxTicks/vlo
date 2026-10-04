import type { GenerationNodeSnapshot } from "../services/generationSessionTypes";
import type {
  WorkflowLoraStack,
  WorkflowRules,
} from "../services/workflowRules";
import type { WorkflowWidgetInput } from "../types";
import {
  LORA_LOADERS_SECTION_ID,
  LORA_MODEL_WIDGET,
  LORA_STRENGTH_WIDGETS,
  isLoraLoaderClass,
} from "./loraLoaderWidgets";
import { getNodeBypassWidgetKey } from "./nodeBypassWidgets";
import type { WidgetValueMap } from "./widgetValueReconciliation";

/**
 * LoRA stacks (`lora_stacks` in workflow rules): interchangeable loaders the
 * panel presents as one growable list.
 *
 * Presentation and dispatch are independent. The panel keeps its state per
 * physical node, as for any loader, and shows every loader with a model
 * selected plus one empty slot. Submission then packs the selected models into
 * the first nodes of the stack, so which node carries which LoRA is decided
 * only when a prompt is built.
 */

const DEFAULT_STACK_GROUP_TITLE = "LoRA";
const MUTED_MODE = 2;

const EMPTY_NODE_IDS: ReadonlySet<string> = new Set<string>();

interface LoraStackSlot {
  readonly nodeId: string;
  readonly modelWidget: WorkflowWidgetInput;
  /**
   * The loader's strengths, which belong to whichever LoRA it carries. Any
   * other control a sidecar declares on the node stays where its author put
   * it: it is neither regrouped, hidden with the slot, nor packed.
   */
  readonly siblingWidgets: readonly WorkflowWidgetInput[];
  /** A model is selected rather than the bypass choice. */
  readonly assigned: boolean;
}

function readStacks(
  rules: WorkflowRules | null | undefined,
): readonly WorkflowLoraStack[] {
  return rules?.lora_stacks ?? [];
}

/** Stack members are discovered even when they ship bypassed. */
export function collectLoraStackNodeIds(
  rules: WorkflowRules | null | undefined,
): ReadonlySet<string> {
  const stacks = readStacks(rules);
  if (stacks.length === 0) return EMPTY_NODE_IDS;
  return new Set(stacks.flatMap((stack) => stack.nodes));
}

function isNodeWidget(widget: WorkflowWidgetInput): boolean {
  return widget.kind !== "derived" && widget.frontendControlId === undefined;
}

function groupNodeWidgets(
  widgetInputs: readonly WorkflowWidgetInput[],
): Map<string, WorkflowWidgetInput[]> {
  const byNode = new Map<string, WorkflowWidgetInput[]>();
  for (const widget of widgetInputs) {
    if (!isNodeWidget(widget)) continue;
    const widgets = byNode.get(widget.nodeId);
    if (widgets) widgets.push(widget);
    else byNode.set(widget.nodeId, [widget]);
  }
  return byNode;
}

/**
 * The stack's usable loaders, in rule order. A member the panel cannot switch
 * off (not discovered, muted, no installed LoRAs) or that its sidecar hid is
 * not a slot: packing must never write a LoRA into a node the user cannot see
 * or turn off.
 */
function resolveStackSlots(
  byNode: ReadonlyMap<string, readonly WorkflowWidgetInput[]>,
  stack: WorkflowLoraStack,
  bypassedWidgetTargets: ReadonlySet<string>,
): LoraStackSlot[] {
  return stack.nodes.flatMap((nodeId) => {
    const widgets = byNode.get(nodeId) ?? [];
    const modelWidget = widgets.find(
      (widget) =>
        widget.param === LORA_MODEL_WIDGET &&
        widget.config.nodeBypassOption !== undefined,
    );
    if (!modelWidget || modelWidget.config.hidden === true) return [];
    return [
      {
        nodeId,
        modelWidget,
        siblingWidgets: widgets.filter((widget) =>
          LORA_STRENGTH_WIDGETS.includes(widget.param),
        ),
        assigned: !bypassedWidgetTargets.has(
          getNodeBypassWidgetKey(nodeId, modelWidget.param),
        ),
      },
    ];
  });
}

/** Every assigned slot, then the first empty one. */
function resolveVisibleSlots(
  slots: readonly LoraStackSlot[],
): readonly LoraStackSlot[] {
  const assigned = slots.filter((slot) => slot.assigned);
  const firstEmpty = slots.find((slot) => !slot.assigned);
  return firstEmpty ? [...assigned, firstEmpty] : assigned;
}

function presentVisibleSlot(
  slot: LoraStackSlot,
  position: number,
  stack: WorkflowLoraStack,
): WorkflowWidgetInput[] {
  const title = stack.group_title?.trim() || DEFAULT_STACK_GROUP_TITLE;
  const presentation = {
    sectionId: stack.section_id?.trim() || LORA_LOADERS_SECTION_ID,
    // Per node, so two slots never merge into one group.
    groupId: `lora-stack:${stack.id}:${slot.nodeId}`,
    groupTitle: `${title} ${position + 1}`,
    // One order for the whole stack: ties between its groups fall back to
    // array position, which is the display order emitted here, and ties
    // inside a group keep the model dropdown ahead of its strengths.
    groupOrder: stack.group_order ?? undefined,
  };
  return [slot.modelWidget, ...slot.siblingWidgets].map((widget) => ({
    ...widget,
    config: { ...widget.config, ...presentation },
  }));
}

function hideSlot(slot: LoraStackSlot): WorkflowWidgetInput[] {
  return [slot.modelWidget, ...slot.siblingWidgets].map((widget) => ({
    ...widget,
    config: { ...widget.config, hidden: true },
  }));
}

/**
 * Present each stack as a list: assigned loaders in stack order, numbered by
 * position, then one empty slot while any remain. Emptied loaders drop out of
 * the list instead of leaving a gap. Hidden slots stay in the widget list
 * with `hidden` set, so their bypass state still reaches submission.
 *
 * Presentation only: submission reads the unpresented widgets.
 */
export function presentLoraStackWidgetInputs(
  widgetInputs: readonly WorkflowWidgetInput[],
  rules: WorkflowRules | null | undefined,
  bypassedWidgetTargets: ReadonlySet<string>,
): readonly WorkflowWidgetInput[] {
  const stacks = readStacks(rules);
  if (stacks.length === 0) return widgetInputs;

  const byNode = groupNodeWidgets(widgetInputs);
  // Each stack's widgets are emitted together where its first widget stood,
  // in display order; the rest of the list keeps its order.
  const stackBlocks = new Map<WorkflowWidgetInput, WorkflowWidgetInput[]>();
  const consumed = new Set<WorkflowWidgetInput>();
  for (const stack of stacks) {
    const slots = resolveStackSlots(byNode, stack, bypassedWidgetTargets);
    if (slots.length === 0) continue;
    const visible = resolveVisibleSlots(slots);
    const visibleNodeIds = new Set(visible.map((slot) => slot.nodeId));
    const block = [
      ...visible.flatMap((slot, position) =>
        presentVisibleSlot(slot, position, stack),
      ),
      ...slots
        .filter((slot) => !visibleNodeIds.has(slot.nodeId))
        .flatMap(hideSlot),
    ];
    const stackWidgets = new Set(
      slots.flatMap((slot) => [slot.modelWidget, ...slot.siblingWidgets]),
    );
    const anchor = widgetInputs.find((widget) => stackWidgets.has(widget));
    if (!anchor) continue;
    stackBlocks.set(anchor, block);
    for (const widget of stackWidgets) consumed.add(widget);
  }
  if (stackBlocks.size === 0) return widgetInputs;

  return widgetInputs.flatMap((widget) => {
    const block = stackBlocks.get(widget);
    if (block) return block;
    return consumed.has(widget) ? [] : [widget];
  });
}

function readWidgetValue(
  widgetValues: WidgetValueMap,
  widget: WorkflowWidgetInput,
): unknown {
  return widgetValues[widget.nodeId]?.[widget.param] ?? widget.currentValue;
}

function writeWidgetValue(
  widgetValues: WidgetValueMap,
  nodeId: string,
  param: string,
  value: unknown,
): WidgetValueMap {
  if (Object.is(widgetValues[nodeId]?.[param], value)) return widgetValues;
  return {
    ...widgetValues,
    [nodeId]: { ...(widgetValues[nodeId] ?? {}), [param]: value },
  };
}

export interface PackLoraStacksOptions {
  readonly widgetInputs: readonly WorkflowWidgetInput[];
  readonly widgetValues: WidgetValueMap;
  readonly bypassedWidgetTargets: ReadonlySet<string>;
  readonly rules: WorkflowRules | null | undefined;
}

export interface PackedLoraStacks {
  readonly widgetValues: WidgetValueMap;
  readonly bypassedWidgetTargets: ReadonlySet<string>;
}

/**
 * Move each stack's selected LoRAs into its first slots, keeping their order,
 * and leave the remaining slots on the bypass choice. The node bypass and
 * activation effects then follow from each slot's own shipped mode, exactly
 * as for an unstacked loader.
 *
 * A strength travels only to a slot that has the same parameter: stacks are
 * meant to be one loader class, and a mixed stack is reported as a rule
 * warning rather than guessed at.
 */
export function packLoraStacks({
  widgetInputs,
  widgetValues,
  bypassedWidgetTargets,
  rules,
}: PackLoraStacksOptions): PackedLoraStacks {
  const stacks = readStacks(rules);
  if (stacks.length === 0) return { widgetValues, bypassedWidgetTargets };

  const byNode = groupNodeWidgets(widgetInputs);
  let nextValues = widgetValues;
  const nextTargets = new Set(bypassedWidgetTargets);
  for (const stack of stacks) {
    const slots = resolveStackSlots(byNode, stack, bypassedWidgetTargets);
    // 1. Snapshot the selections before any slot is overwritten.
    const entries = slots
      .filter((slot) => slot.assigned)
      .map((slot) => ({
        model: readWidgetValue(widgetValues, slot.modelWidget),
        siblings: new Map(
          slot.siblingWidgets.map((widget) => [
            widget.param,
            readWidgetValue(widgetValues, widget),
          ]),
        ),
      }));
    // 2. Write them into the leading slots and switch the rest off.
    for (const [index, slot] of slots.entries()) {
      const key = getNodeBypassWidgetKey(slot.nodeId, slot.modelWidget.param);
      const entry = entries[index];
      if (!entry) {
        nextTargets.add(key);
        continue;
      }
      nextTargets.delete(key);
      nextValues = writeWidgetValue(
        nextValues,
        slot.nodeId,
        slot.modelWidget.param,
        entry.model,
      );
      for (const sibling of slot.siblingWidgets) {
        if (!entry.siblings.has(sibling.param)) continue;
        nextValues = writeWidgetValue(
          nextValues,
          slot.nodeId,
          sibling.param,
          entry.siblings.get(sibling.param),
        );
      }
    }
  }
  return { widgetValues: nextValues, bypassedWidgetTargets: nextTargets };
}

/** Report stack members the panel cannot use as slots, and mixed stacks. */
export function collectLoraStackDiagnostics(
  nodes: readonly GenerationNodeSnapshot[],
  rules: WorkflowRules | null | undefined,
): readonly string[] {
  const stacks = readStacks(rules);
  if (stacks.length === 0) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const diagnostics: string[] = [];
  for (const stack of stacks) {
    const classTypes = new Set<string>();
    for (const nodeId of stack.nodes) {
      const node = byId.get(nodeId);
      if (!node) continue;
      const label = `${nodeId} (${node.title || node.classType})`;
      if (!isLoraLoaderClass(node.classType)) {
        diagnostics.push(
          `LoRA stack '${stack.id}' lists node ${label}, which is not a LoRA loader; it is left out of the stack.`,
        );
        continue;
      }
      if (node.mode === MUTED_MODE) {
        diagnostics.push(
          `LoRA stack '${stack.id}' lists node ${label}, which ships muted; ` +
            "only active or bypassed loaders can be used.",
        );
        continue;
      }
      classTypes.add(node.classType);
    }
    if (classTypes.size > 1) {
      diagnostics.push(
        `LoRA stack '${stack.id}' mixes loader classes ${[...classTypes].join(", ")}; ` +
          "packing only carries settings both classes have.",
      );
    }
  }
  return diagnostics;
}
