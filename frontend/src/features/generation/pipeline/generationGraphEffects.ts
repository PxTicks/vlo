import {
  evaluateEffectSwitchesForState,
  evaluateRewrites,
  evaluateWidgetDefaultOverrides,
  type RewriteRule,
  type WidgetOverride,
} from "../services/evaluateRewrites";
import type {
  GenerationCapturedEffects,
  GenerationEffectDiagnostic,
  GenerationEffectJsonValue,
  GenerationEffectSource,
  GenerationGraphEffect,
  GenerationPlan,
  GenerationWorkflowExpectation,
} from "./types";

// Normalization for the closed graph-effect union
// (docs/generation-native-extension-seams-plan.md §3.3). This module owns
// deterministic validation, exact-duplicate removal, collision diagnostics,
// and source attribution. The iframe bridge remains responsible for
// clone-time application, target existence, and final prompt verification.

interface GenerationEffectSourceGroup {
  source: GenerationEffectSource;
  bypassNodeIds: readonly unknown[];
  widgetOverrides: readonly WidgetOverride[];
}

export interface NormalizedGenerationEffects {
  effects: readonly GenerationGraphEffect[];
  diagnostics: readonly GenerationEffectDiagnostic[];
}

export interface GenerationBridgeEffectPayload {
  bypassNodeIds: string[];
  widgetOverrides: WidgetOverride[];
}

/**
 * Stable, strict JSON serialization: object keys are sorted so semantically
 * equal values compare equal, and anything JSON cannot represent faithfully
 * (undefined, functions, symbols, bigints, non-finite numbers, cycles)
 * returns `null` instead of being silently coerced.
 */
function serializeFiniteJson(value: unknown): string | null {
  const seen = new Set<object>();

  function serialize(current: unknown): string | null {
    if (current === null) {
      return "null";
    }
    switch (typeof current) {
      case "string":
      case "boolean":
        return JSON.stringify(current);
      case "number":
        return Number.isFinite(current) ? JSON.stringify(current) : null;
      case "object":
        break;
      default:
        return null;
    }

    const objectValue = current as object;
    if (seen.has(objectValue)) {
      return null;
    }
    seen.add(objectValue);

    let result: string | null;
    if (Array.isArray(objectValue)) {
      const parts: string[] = [];
      result = "";
      for (const item of objectValue) {
        const part = serialize(item);
        if (part === null) {
          result = null;
          break;
        }
        parts.push(part);
      }
      if (result !== null) {
        result = `[${parts.join(",")}]`;
      }
    } else {
      const record = objectValue as Record<string, unknown>;
      const parts: string[] = [];
      result = "";
      for (const key of Object.keys(record).sort()) {
        const part = serialize(record[key]);
        if (part === null) {
          result = null;
          break;
        }
        parts.push(`${JSON.stringify(key)}:${part}`);
      }
      if (result !== null) {
        result = `{${parts.join(",")}}`;
      }
    }

    seen.delete(objectValue);
    return result;
  }

  return serialize(value);
}

function describeTarget(nodeId: unknown, widget?: unknown): string {
  const node = typeof nodeId === "string" && nodeId.trim().length > 0
    ? nodeId.trim()
    : "<missing node id>";
  if (typeof widget === "undefined") {
    return node;
  }
  const widgetName = typeof widget === "string" && widget.trim().length > 0
    ? widget.trim()
    : "<missing widget>";
  return `${node}.${widgetName}`;
}

/**
 * Collapse attributed effect sources into the closed union. Deterministic for
 * a given input: iteration order is source order, exact duplicates are
 * dropped (first occurrence keeps the attribution), and conflicting widget
 * writes keep the later write — matching the bridge's sequential apply order —
 * while recording a collision diagnostic.
 */
export function normalizeGenerationGraphEffects(
  groups: readonly GenerationEffectSourceGroup[],
): NormalizedGenerationEffects {
  const effects: GenerationGraphEffect[] = [];
  const diagnostics: GenerationEffectDiagnostic[] = [];
  const seenBypassIds = new Set<string>();
  const widgetWrites = new Map<
    string,
    { index: number; serialized: string; source: GenerationEffectSource }
  >();

  for (const group of groups) {
    const nodeIds: string[] = [];
    for (const rawNodeId of group.bypassNodeIds) {
      const nodeId = typeof rawNodeId === "string" ? rawNodeId.trim() : "";
      if (nodeId.length === 0) {
        diagnostics.push({
          severity: "error",
          code: "invalid-target",
          source: group.source,
          message: `Bypass target from ${group.source} is not a valid node id`,
        });
        continue;
      }
      if (seenBypassIds.has(nodeId)) {
        continue;
      }
      seenBypassIds.add(nodeId);
      nodeIds.push(nodeId);
    }
    if (nodeIds.length > 0) {
      effects.push({ kind: "bypass-nodes", nodeIds, source: group.source });
    }

    for (const override of group.widgetOverrides) {
      const nodeId =
        typeof override.node_id === "string" ? override.node_id.trim() : "";
      const widget =
        typeof override.widget === "string" ? override.widget.trim() : "";
      if (nodeId.length === 0 || widget.length === 0) {
        diagnostics.push({
          severity: "error",
          code: "invalid-target",
          source: group.source,
          message: `Widget write from ${group.source} targets ${describeTarget(
            override.node_id,
            override.widget,
          )}, which is not a valid node/widget pair`,
        });
        continue;
      }

      const serialized = serializeFiniteJson(override.value);
      if (serialized === null) {
        diagnostics.push({
          severity: "error",
          code: "invalid-value",
          source: group.source,
          message: `Widget write from ${group.source} for ${describeTarget(
            nodeId,
            widget,
          )} has a value that cannot be represented as finite JSON`,
        });
        continue;
      }

      const effect: GenerationGraphEffect = {
        kind: "set-widget",
        target: { nodeId, widget },
        value: JSON.parse(serialized) as GenerationEffectJsonValue,
        source: group.source,
      };
      // Serialized tuple: keeps the delimiter unambiguous without putting a
      // control character in this source file.
      const key = JSON.stringify([nodeId, widget]);
      const existing = widgetWrites.get(key);
      if (!existing) {
        widgetWrites.set(key, {
          index: effects.length,
          serialized,
          source: group.source,
        });
        effects.push(effect);
        continue;
      }
      if (existing.serialized === serialized) {
        continue;
      }
      diagnostics.push({
        severity: "warning",
        code: "widget-collision",
        source: group.source,
        message: `Widget ${describeTarget(nodeId, widget)} is written by both ${
          existing.source
        } and ${group.source}; the ${group.source} value wins`,
      });
      effects[existing.index] = effect;
      existing.serialized = serialized;
      existing.source = group.source;
    }
  }

  return { effects, diagnostics };
}

/**
 * Evaluate every native effect source for a plan and freeze the normalized
 * result. Reads only detached plan data plus the caller-supplied provided
 * inputs and workflow expectation — never live store or editor state.
 */
export function captureGenerationEffectsForPlan(
  plan: GenerationPlan,
  providedInputIds: ReadonlySet<string>,
  expectation: GenerationWorkflowExpectation | null,
): GenerationCapturedEffects {
  const rules = plan.workflow.workflowRules;
  const widgetValues = plan.submission.frontendStateWidgetValues;
  const inputMetadata = plan.submission.inputMetadata;

  const defaultOverrides = evaluateWidgetDefaultOverrides(
    rules,
    providedInputIds,
    widgetValues,
    inputMetadata,
  );
  const rewriteEffects = evaluateRewrites(
    (rules?.rewrites as RewriteRule[] | undefined) ?? [],
    providedInputIds,
    widgetValues,
    inputMetadata,
  );
  const effectSwitchEffects = evaluateEffectSwitchesForState(
    rules?.effect_switches ?? [],
    providedInputIds,
    widgetValues,
    inputMetadata,
  );

  // Widget-write order must stay defaults → rewrites → effect switches so the
  // last-write-wins collision rule matches the bridge's historical apply
  // order. Bypass ordering is set-like and does not matter.
  const { effects, diagnostics } = normalizeGenerationGraphEffects([
    {
      source: "rule-default-override",
      bypassNodeIds: [],
      widgetOverrides: defaultOverrides,
    },
    {
      source: "rule-rewrite",
      bypassNodeIds: rewriteEffects.bypass,
      widgetOverrides: rewriteEffects.widgetOverrides,
    },
    {
      source: "rule-effect-switch",
      bypassNodeIds: effectSwitchEffects.bypass,
      widgetOverrides: effectSwitchEffects.widgetOverrides,
    },
    {
      source: "panel-bypass",
      bypassNodeIds: plan.submission.bypassNodeIds,
      widgetOverrides: [],
    },
  ]);

  return { schemaVersion: 1, expectation, effects, diagnostics };
}

/** Flatten normalized effects into the bridge's resolve-prompt arguments. */
export function buildBridgeEffectPayload(
  effects: readonly GenerationGraphEffect[],
): GenerationBridgeEffectPayload {
  const bypassNodeIds: string[] = [];
  const widgetOverrides: WidgetOverride[] = [];
  for (const effect of effects) {
    if (effect.kind === "bypass-nodes") {
      bypassNodeIds.push(...effect.nodeIds);
    } else {
      widgetOverrides.push({
        node_id: effect.target.nodeId,
        widget: effect.target.widget,
        value: effect.value,
      });
    }
  }
  return { bypassNodeIds, widgetOverrides };
}

/**
 * Would two captures resolve the prompt identically? Compares the bridge
 * arguments only: source attribution and diagnostics describe how an effect
 * came to be, not what the resolved prompt looks like. Normalized values have
 * sorted keys, so serializing the payload is a stable comparison.
 */
export function bridgeEffectPayloadsMatch(
  left: GenerationCapturedEffects,
  right: GenerationCapturedEffects,
): boolean {
  return (
    JSON.stringify(buildBridgeEffectPayload(left.effects)) ===
    JSON.stringify(buildBridgeEffectPayload(right.effects))
  );
}

export function collectGenerationEffectErrors(
  captured: GenerationCapturedEffects,
): string[] {
  return captured.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
}
