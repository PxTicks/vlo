import type {
  GenerationEffectJsonValue,
  GenerationWidgetTarget,
} from "../pipeline/types";
import type { WidgetValueType } from "../types";

/**
 * The owner-neutral generation session contract
 * (docs/generation-native-extension-seams-plan.md §3.1–§3.2).
 *
 * Nothing here knows about extensions: the generation feature mounts the
 * session, native panel controls write through it, and a trusted adapter may
 * later project it. Snapshots are immutable and detached — a consumer holding
 * one can never write back through it.
 */

export type GenerationSessionJsonValue = GenerationEffectJsonValue;
export type { GenerationWidgetTarget };

/** How the mounted workflow was obtained. */
export type GenerationWorkflowSourceMode = "catalogue" | "temporary" | "manual";

/** One widget-backed parameter of a node, as discovered from the graph. */
export interface GenerationWidgetSnapshot {
  readonly nodeId: string;
  readonly param: string;
  readonly valueType: WidgetValueType;
  /** Current value, or `null` when the graph carries nothing representable. */
  readonly value: GenerationSessionJsonValue | null;
  readonly defaultValue: GenerationSessionJsonValue | null;
  readonly options: readonly (string | number | boolean)[] | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
  /** Fed by a node connection, so it carries no editable widget value. */
  readonly linked: boolean;
  /** Occupies a `[value, mode]` slot pair and can be randomized per run. */
  readonly controlAfterGenerate: boolean;
}

export interface GenerationNodeSnapshot {
  /** Execution id: `<id>`, or `<instanceId>:<innerId>` inside a subgraph. */
  readonly id: string;
  readonly classType: string;
  readonly title: string;
  /** LiteGraph node mode: 0 = always, 2 = muted, 4 = bypassed. */
  readonly mode: number;
  readonly widgets: readonly GenerationWidgetSnapshot[];
}

export interface GenerationWorkflowSnapshot {
  readonly sourceId: string | null;
  /**
   * The ComfyUI bridge's workflow instance id, or `null` before the iframe has
   * reported identity. (The plan sketches this as a bare `string`; the mounted
   * session can legitimately exist before the bridge has answered, and callers
   * that pin work to an instance must handle that.)
   */
  readonly instanceId: string | null;
  /** Bumps whenever workflow identity or the node catalogue changes. */
  readonly revision: number;
  readonly fingerprint: string;
  readonly mode: GenerationWorkflowSourceMode;
  readonly nodes: readonly GenerationNodeSnapshot[];
}

/** A panel input slot (prompt text or a media slot). */
export interface GenerationInputSnapshot {
  readonly id: string;
  readonly nodeId: string;
  readonly param: string;
  readonly label: string;
  readonly description?: string;
  readonly inputType: "text" | "image" | "video" | "audio";
  /** Present for text inputs only. */
  readonly value?: string;
}

/**
 * A widget the mounted panel can actually write. The node catalogue is wider
 * than this: it describes everything in the graph, while only bound widgets
 * have a control whose value reaches the submitted prompt.
 */
export interface GenerationEditableWidgetSnapshot {
  readonly target: GenerationWidgetTarget;
  readonly valueType: WidgetValueType;
  readonly value: GenerationSessionJsonValue | null;
  readonly options: readonly (string | number | boolean)[] | null;
  readonly min: number | null;
  readonly max: number | null;
  /** Values a boolean widget serializes to, when the rules override them. */
  readonly trueValue: GenerationSessionJsonValue | null;
  readonly falseValue: GenerationSessionJsonValue | null;
}

export interface GenerationSessionReadiness {
  readonly isLoading: boolean;
  readonly isReady: boolean;
  /**
   * The mounted workflow failed to load. Distinct from "not ready yet": no
   * further readiness arrives without the user retrying or picking another
   * workflow, which a consumer waiting on the session has to be able to tell.
   */
  readonly hasError: boolean;
}

export interface GenerationSessionSubmission {
  readonly isBusy: boolean;
  readonly queuedCount: number;
  /**
   * The panel would accept a submission right now. Wider than readiness: it
   * also covers the ComfyUI connection and the workflow's required inputs, so
   * a consumer must not derive it from `readiness` alone.
   */
  readonly canSubmit: boolean;
}

export interface GenerationSessionSnapshot {
  /** Monotonic per-mount counter; bumps on every published change. */
  readonly revision: number;
  readonly workflow: GenerationWorkflowSnapshot;
  readonly inputs: readonly GenerationInputSnapshot[];
  readonly editableWidgets: readonly GenerationEditableWidgetSnapshot[];
  readonly readiness: GenerationSessionReadiness;
  readonly submission: GenerationSessionSubmission;
}

/** What the mounting feature publishes; the service derives revisions. */
export interface GenerationSessionPublication {
  readonly sourceId: string | null;
  readonly instanceId: string | null;
  readonly fingerprint: string;
  readonly mode: GenerationWorkflowSourceMode;
  /**
   * Stable identity matters: the service treats a new array identity as a
   * workflow-revision bump, so callers should memoize the catalogue.
   */
  readonly nodes: readonly GenerationNodeSnapshot[];
  readonly inputs: readonly GenerationInputSnapshot[];
  readonly editableWidgets: readonly GenerationEditableWidgetSnapshot[];
  readonly readiness: GenerationSessionReadiness;
  readonly submission: GenerationSessionSubmission;
}

export interface GenerationSessionTransaction {
  setTextInput(inputId: string, value: string): void;
  setWidget(target: GenerationWidgetTarget, value: unknown): void;
}

export type GenerationTransactionFailureCode =
  | "invalid_label"
  | "unavailable"
  /** The mounted workflow changed while the transaction's callback ran. */
  | "workflow_changed"
  | "invalid_command"
  | "callback_failed"
  | "input_not_found"
  | "input_type_mismatch"
  | "widget_not_found"
  | "widget_not_editable"
  | "widget_value_invalid";

export type GenerationTransactionResult =
  | { readonly ok: true; readonly changed: boolean; readonly label: string }
  | {
      readonly ok: false;
      readonly code: GenerationTransactionFailureCode;
      readonly message: string;
      readonly label: string;
    };

export interface GenerationSessionWidgetCommit {
  readonly target: GenerationWidgetTarget;
  readonly value: GenerationSessionJsonValue;
}

export interface GenerationSessionCommit {
  /** Canonical input id → value. Empty when the transaction wrote no text. */
  readonly textInputs: ReadonlyMap<string, string>;
  readonly widgets: readonly GenerationSessionWidgetCommit[];
}

/** The mounting feature's write side. Called at most once per transaction. */
export interface GenerationSessionHost {
  commit(update: GenerationSessionCommit): void;
}
