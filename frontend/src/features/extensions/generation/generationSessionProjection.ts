import { serializeFiniteJson } from "../../generation/utils/finiteJson";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationNodeSnapshot,
  GenerationSessionSnapshot,
  GenerationWidgetSnapshot,
} from "../../generation/services/generationSessionTypes";
import type {
  ExtensionGenerationInputSnapshot,
  ExtensionGenerationNodeSnapshot,
  ExtensionGenerationSessionSnapshot,
  ExtensionGenerationWidgetSnapshot,
  ExtensionGenerationWidgetValueType,
  ExtensionGenerationWorkflowSnapshot,
  JsonValue,
} from "../types";

/**
 * The detached projection of the generation session for the SDK
 * (docs/generation-extension-surface-plan.md §2.1, E1).
 *
 * Pure and owner-free: the adapter adds activation scope and diagnostics
 * around it. Three properties matter to a consumer and drive the shape here:
 *
 * - **Detached.** Every object is rebuilt and deeply frozen, so nothing an
 *   extension holds is a reference into host state, and nothing it does to a
 *   snapshot can reach the panel.
 * - **Stable.** The same frozen object is returned until the host publishes a
 *   change, so `getSession` can be handed to `useSyncExternalStore` without
 *   re-rendering forever. That is why the projection is memoized rather than
 *   cloned per call: a fresh clone each call is a render loop.
 * - **Bounded.** Building and freezing happen on the panel's render path, so
 *   every dimension has both a per-item limit and a whole-snapshot budget.
 */

/**
 * Bounds on what one snapshot can carry.
 *
 * Per-item limits alone are not bounds: nodes × widgets × options multiply, so
 * each dimension also has an aggregate budget spent across the whole snapshot,
 * and values and enum options share one byte budget. A workflow's catalogue is
 * host-shaped, not extension-shaped — an enum backed by a model directory can
 * list thousands of entries — and the diagnostics describing what was dropped
 * are themselves capped, since one note per dropped item is its own leak.
 */
export const GENERATION_SNAPSHOT_LIMITS = {
  nodes: 2_000,
  widgetsPerNode: 128,
  /** Widgets across the whole snapshot. */
  widgets: 5_000,
  optionsPerWidget: 2_000,
  /** Enum options across the whole snapshot. */
  options: 20_000,
  /** Serialized length of one widget value, default, or enum option. */
  valueLength: 64 * 1024,
  /** Serialized characters across all widget values, defaults, and options. */
  valueBytes: 4 * 1024 * 1024,
  /** Nesting depth of one widget value or default. */
  valueDepth: 8,
  inputs: 128,
  /** Matches the adapter's write bound: what you can write, you can read. */
  inputValueLength: 1_000_000,
  /** Characters across all published input values. */
  inputBytes: 4 * 1024 * 1024,
  /** Notes about what the limits dropped. */
  diagnostics: 32,
} as const;

export interface GenerationSessionProjection {
  readonly session: ExtensionGenerationSessionSnapshot;
  /**
   * What the limits dropped, if anything. The adapter reports these once per
   * revision: a silently truncated catalogue would read to an extension as a
   * workflow that simply does not contain the node it is looking for.
   */
  readonly truncations: readonly string[];
}

/**
 * The remaining allowance for one projection pass, plus the notes explaining
 * what it refused. Passed down rather than held in module state so a cached
 * node projection keeps the notes it was built with.
 */
interface ProjectionBudget {
  widgets: number;
  options: number;
  bytes: number;
  readonly notes: string[];
  suppressed: number;
}

function createBudget(): ProjectionBudget {
  return {
    widgets: GENERATION_SNAPSHOT_LIMITS.widgets,
    options: GENERATION_SNAPSHOT_LIMITS.options,
    bytes: GENERATION_SNAPSHOT_LIMITS.valueBytes,
    notes: [],
    suppressed: 0,
  };
}

function note(budget: ProjectionBudget, message: string): void {
  if (budget.notes.length < GENERATION_SNAPSHOT_LIMITS.diagnostics) {
    budget.notes.push(message);
    return;
  }
  budget.suppressed += 1;
}

/** Cap a note list, replacing the tail with a count of what it stands for. */
function capNotes(
  notes: readonly string[],
  suppressed: number,
): readonly string[] {
  const kept = notes.slice(0, GENERATION_SNAPSHOT_LIMITS.diagnostics);
  const hidden = suppressed + (notes.length - kept.length);
  if (hidden === 0) return Object.freeze(kept);
  return Object.freeze([
    ...kept,
    `…and ${hidden} further snapshot limit${hidden === 1 ? "" : "s"}.`,
  ]);
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}

function exceedsDepth(value: JsonValue, depth: number): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth >= GENERATION_SNAPSHOT_LIMITS.valueDepth) return true;
  const entries = Array.isArray(value) ? value : Object.values(value);
  return entries.some((entry) => exceedsDepth(entry, depth + 1));
}

/**
 * A widget value as finite JSON, detached from the host, or `null` when it
 * cannot be carried within the limits. `null` already means "nothing
 * representable" in this position, so an oversized value degrades into the
 * same shape a consumer must already handle — with a note, so the reason is
 * not invisible.
 */
function boundValue(
  value: unknown,
  describe: string,
  budget: ProjectionBudget,
): JsonValue | null {
  if (value === null || value === undefined) return null;
  const serialized = serializeFiniteJson(value);
  if (serialized === null) {
    note(budget, `${describe} is not representable as finite JSON.`);
    return null;
  }
  if (serialized.length > GENERATION_SNAPSHOT_LIMITS.valueLength) {
    note(
      budget,
      `${describe} exceeds ${GENERATION_SNAPSHOT_LIMITS.valueLength} serialized characters.`,
    );
    return null;
  }
  if (serialized.length > budget.bytes) {
    note(budget, `${describe} did not fit the snapshot's value budget.`);
    return null;
  }
  const parsed = JSON.parse(serialized) as JsonValue;
  if (exceedsDepth(parsed, 0)) {
    note(
      budget,
      `${describe} nests deeper than ${GENERATION_SNAPSHOT_LIMITS.valueDepth} levels.`,
    );
    return null;
  }
  budget.bytes -= serialized.length;
  return parsed;
}

/** What one enum option costs the byte budget. */
function optionCost(option: string | number | boolean): number {
  return typeof option === "string" ? option.length : 8;
}

/**
 * Enum options within the per-widget cap, the snapshot's option count, and the
 * shared byte budget. Options are dropped rather than shortened: a truncated
 * enum entry is not a value the widget accepts, so publishing it would invite
 * a write that can only fail. Non-finite numbers go the same way — `typeof
 * option === "number"` upstream admits `NaN`, which has no JSON form.
 */
function boundOptions(
  options: readonly (string | number | boolean)[] | null,
  describe: string,
  budget: ProjectionBudget,
): readonly (string | number | boolean)[] | null {
  if (!options) return null;
  const allowed = Math.max(
    0,
    Math.min(GENERATION_SNAPSHOT_LIMITS.optionsPerWidget, budget.options),
  );
  const kept: (string | number | boolean)[] = [];
  let dropped = 0;
  for (const option of options) {
    if (kept.length >= allowed) {
      dropped += 1;
      continue;
    }
    if (typeof option === "number" && !Number.isFinite(option)) {
      dropped += 1;
      continue;
    }
    if (
      typeof option === "string" &&
      option.length > GENERATION_SNAPSHOT_LIMITS.valueLength
    ) {
      dropped += 1;
      continue;
    }
    const cost = optionCost(option);
    if (cost > budget.bytes) {
      dropped += 1;
      continue;
    }
    budget.bytes -= cost;
    kept.push(option);
  }
  budget.options -= kept.length;
  if (dropped > 0) {
    note(
      budget,
      `${describe} lists ${options.length} options; ${dropped} could not be published.`,
    );
  }
  return kept;
}

/** Non-finite numeric metadata has no JSON form, so it is published as absent. */
function boundNumber(
  value: number | null,
  describe: string,
  budget: ProjectionBudget,
): number | null {
  if (value === null) return null;
  if (Number.isFinite(value)) return value;
  note(budget, `${describe} is not a finite number.`);
  return null;
}

export function widgetEditableKey(nodeId: string, widget: string): string {
  // NUL-separated: a node id or widget name carrying the separator would
  // otherwise collide with a different pair.
  return `${nodeId}\u0000${widget}`;
}

/** The constraint set a write against one target is judged against. */
interface MergedBinding {
  readonly valueType: ExtensionGenerationWidgetValueType;
  readonly value: unknown;
  readonly options: readonly (string | number | boolean)[] | null;
  readonly min: number | null;
  readonly max: number | null;
}

/**
 * Collapse every control bound to one target into the constraints a write is
 * actually judged against.
 *
 * The host accepts a value when *any* binding accepts it, so publishing the
 * first binding's constraints would describe a narrower widget than the one
 * being validated. The union is what the accept rule means: an unrestricted
 * binding (no options, no bound) makes the target unrestricted in that
 * dimension, and disagreeing value types make it unjudgeable here, which is
 * what `unknown` says publicly.
 *
 * For several bounded ranges the published pair is the outer envelope, since
 * one min/max cannot express a gap between them. That over-approximates in the
 * one direction a consumer can recover from: the write is still refused, with
 * a message naming the real constraint.
 */
function mergeBindings(
  bindings: readonly GenerationEditableWidgetSnapshot[],
): MergedBinding {
  const [first] = bindings;
  let valueType: ExtensionGenerationWidgetValueType = first.valueType;
  let options: (string | number | boolean)[] | null = [];
  let min: number | null = Number.POSITIVE_INFINITY;
  let max: number | null = Number.NEGATIVE_INFINITY;

  for (const binding of bindings) {
    if (binding.valueType !== valueType) valueType = "unknown";
    if (!binding.options || binding.options.length === 0) {
      options = null;
    } else if (options) {
      for (const option of binding.options) {
        if (!options.includes(option)) options.push(option);
      }
    }
    min =
      binding.min === null || min === null ? null : Math.min(min, binding.min);
    max =
      binding.max === null || max === null ? null : Math.max(max, binding.max);
  }

  return {
    valueType,
    value: first.value,
    options,
    min: min === Number.POSITIVE_INFINITY ? null : min,
    max: max === Number.NEGATIVE_INFINITY ? null : max,
  };
}

/**
 * For an editable widget the panel's binding is the whole story, not a
 * preferred source with the catalogue behind it.
 *
 * The two describe the same widget from different places — the catalogue from
 * the synced prompt and `object_info`, the binding from the panel control and
 * the workflow rules — and only the binding is consulted when a write is
 * validated. Falling back to the catalogue for a `null` binding constraint
 * would publish a restriction the host does not enforce: a binding with no
 * options accepts any scalar, so borrowing the catalogue's enum there would
 * advertise a closed list that a write can legitimately step outside of.
 * `step` is the exception, because the binding has no such field.
 */
function projectWidget(
  widget: GenerationWidgetSnapshot,
  nodeId: string,
  bindings: ReadonlyMap<string, readonly GenerationEditableWidgetSnapshot[]>,
  budget: ProjectionBudget,
): ExtensionGenerationWidgetSnapshot {
  const describe = `Widget '${nodeId}.${widget.param}'`;
  const bound = bindings.get(widgetEditableKey(nodeId, widget.param));
  const binding = bound && bound.length > 0 ? mergeBindings(bound) : null;
  return {
    nodeId,
    param: widget.param,
    valueType: binding?.valueType ?? widget.valueType,
    value: boundValue(
      binding ? binding.value : widget.value,
      `${describe} value`,
      budget,
    ),
    defaultValue: boundValue(
      widget.defaultValue,
      `${describe} default`,
      budget,
    ),
    options: boundOptions(
      binding ? binding.options : widget.options,
      describe,
      budget,
    ),
    min: boundNumber(
      binding ? binding.min : widget.min,
      `${describe} minimum`,
      budget,
    ),
    max: boundNumber(
      binding ? binding.max : widget.max,
      `${describe} maximum`,
      budget,
    ),
    step: boundNumber(widget.step, `${describe} step`, budget),
    linked: widget.linked,
    editable: binding !== null,
  };
}

function projectNode(
  node: GenerationNodeSnapshot,
  bindings: ReadonlyMap<string, readonly GenerationEditableWidgetSnapshot[]>,
  budget: ProjectionBudget,
): ExtensionGenerationNodeSnapshot {
  const allowed = Math.max(
    0,
    Math.min(GENERATION_SNAPSHOT_LIMITS.widgetsPerNode, budget.widgets),
  );
  const widgets = node.widgets.slice(0, allowed);
  budget.widgets -= widgets.length;
  if (node.widgets.length > widgets.length) {
    note(
      budget,
      `Node '${node.id}' has ${node.widgets.length} widgets; only ${widgets.length} fit the published limits.`,
    );
  }
  return {
    id: node.id,
    classType: node.classType,
    title: node.title,
    // LiteGraph's default mode, and what ComfyUI assumes for a node without
    // one. A non-finite mode has no JSON form and no meaning to preserve.
    mode: boundNumber(node.mode, `Node '${node.id}' mode`, budget) ?? 0,
    widgets: widgets.map((widget) =>
      projectWidget(widget, node.id, bindings, budget),
    ),
  };
}

/**
 * Panel inputs, bounded on their own budget rather than the catalogue's: they
 * are published on every session revision, while the node projection is cached.
 * An oversized prompt is published as absent rather than shortened — an
 * extension that read a truncated prompt and wrote it back would silently
 * destroy the user's text.
 */
function projectInputs(
  inputs: GenerationSessionSnapshot["inputs"],
  notes: string[],
): readonly ExtensionGenerationInputSnapshot[] {
  const kept = inputs.slice(0, GENERATION_SNAPSHOT_LIMITS.inputs);
  if (inputs.length > kept.length) {
    notes.push(
      `The panel has ${inputs.length} inputs; only the first ${GENERATION_SNAPSHOT_LIMITS.inputs} are published.`,
    );
  }
  let bytes: number = GENERATION_SNAPSHOT_LIMITS.inputBytes;
  return kept.map((input) => {
    let value = input.value;
    if (value !== undefined) {
      if (value.length > GENERATION_SNAPSHOT_LIMITS.inputValueLength) {
        notes.push(
          `Input '${input.id}' exceeds ${GENERATION_SNAPSHOT_LIMITS.inputValueLength} characters and is published without its value.`,
        );
        value = undefined;
      } else if (value.length > bytes) {
        notes.push(
          `Input '${input.id}' did not fit the snapshot's input budget.`,
        );
        value = undefined;
      } else {
        bytes -= value.length;
      }
    }
    return {
      id: input.id,
      nodeId: input.nodeId,
      param: input.param,
      ...(input.description ? { description: input.description } : {}),
      label: input.label,
      inputType: input.inputType,
      ...(value !== undefined ? { value } : {}),
    };
  });
}

/**
 * `error` is the workflow failing to load, not a run failing — the panel keeps
 * a session mounted across a failed generation. Anything else that is not
 * ready yet reads as `loading`, including the state before a workflow has been
 * chosen: from a consumer's side both mean "wait, and watch the revision".
 */
function projectStatus(
  readiness: GenerationSessionSnapshot["readiness"],
): ExtensionGenerationSessionSnapshot["status"] {
  if (readiness.hasError) return "error";
  return readiness.isReady && !readiness.isLoading ? "ready" : "loading";
}

interface WorkflowCacheEntry {
  readonly nodes: readonly GenerationNodeSnapshot[];
  readonly editableWidgets: readonly GenerationEditableWidgetSnapshot[];
  readonly workflowRevision: number;
  readonly nodeSnapshots: readonly ExtensionGenerationNodeSnapshot[];
  readonly truncations: readonly string[];
}

interface SessionCacheEntry {
  readonly snapshot: GenerationSessionSnapshot;
  readonly projection: GenerationSessionProjection;
}

// Single-entry caches: the session has one mounted snapshot at a time, and
// every projected object is immutable, so all owners can share one projection.
let workflowCache: WorkflowCacheEntry | null = null;
let sessionCache: SessionCacheEntry | null = null;

/**
 * Do two publications describe the same widget bindings, in the fields a
 * projected widget reads from them?
 *
 * Structural rather than by identity: the session service copies the binding
 * array into every snapshot it publishes, so identity changes on a keystroke
 * in an unrelated prompt field. Comparing exactly what is read keeps the node
 * projection out of that path while still reprojecting when a binding's value
 * or constraints actually move.
 */
function sameBindings(
  left: readonly GenerationEditableWidgetSnapshot[],
  right: readonly GenerationEditableWidgetSnapshot[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((binding, index) => {
    const other = right[index];
    return (
      binding.target.nodeId === other.target.nodeId &&
      binding.target.widget === other.target.widget &&
      binding.valueType === other.valueType &&
      Object.is(binding.value, other.value) &&
      binding.min === other.min &&
      binding.max === other.max &&
      (binding.options === other.options ||
        (binding.options !== null &&
          other.options !== null &&
          binding.options.length === other.options.length &&
          binding.options.every((option, optionIndex) =>
            Object.is(option, other.options?.[optionIndex]),
          )))
    );
  });
}

/**
 * Node projection is the expensive half and the half that rarely changes: a
 * prompt keystroke republishes the session but touches neither the catalogue
 * nor the widget bindings. Keyed by both, because a projected widget reads
 * from its bindings wherever there are any.
 */
function projectWorkflowNodes(
  snapshot: GenerationSessionSnapshot,
): Pick<WorkflowCacheEntry, "nodeSnapshots" | "truncations"> {
  const cached = workflowCache;
  if (
    cached &&
    cached.nodes === snapshot.workflow.nodes &&
    cached.workflowRevision === snapshot.workflow.revision &&
    sameBindings(cached.editableWidgets, snapshot.editableWidgets)
  ) {
    return cached;
  }

  // Every binding for a target, not the first: the host accepts a value when
  // any of them accepts it, so all of them describe the widget.
  const bindings = new Map<string, GenerationEditableWidgetSnapshot[]>();
  for (const widget of snapshot.editableWidgets) {
    const key = widgetEditableKey(widget.target.nodeId, widget.target.widget);
    const existing = bindings.get(key);
    if (existing) existing.push(widget);
    else bindings.set(key, [widget]);
  }

  const budget = createBudget();
  const nodes = snapshot.workflow.nodes.slice(
    0,
    GENERATION_SNAPSHOT_LIMITS.nodes,
  );
  if (snapshot.workflow.nodes.length > nodes.length) {
    note(
      budget,
      `The workflow has ${snapshot.workflow.nodes.length} nodes; only the first ${GENERATION_SNAPSHOT_LIMITS.nodes} are published.`,
    );
  }
  const nodeSnapshots = deepFreeze(
    nodes.map((node) => projectNode(node, bindings, budget)),
  );

  workflowCache = {
    nodes: snapshot.workflow.nodes,
    workflowRevision: snapshot.workflow.revision,
    editableWidgets: snapshot.editableWidgets,
    nodeSnapshots,
    truncations: capNotes(budget.notes, budget.suppressed),
  };
  return workflowCache;
}

/** Project one published session snapshot. Repeated calls reuse the result. */
export function projectGenerationSession(
  snapshot: GenerationSessionSnapshot,
): GenerationSessionProjection {
  const cached = sessionCache;
  if (cached && cached.snapshot === snapshot) return cached.projection;

  const { nodeSnapshots, truncations } = projectWorkflowNodes(snapshot);

  const workflow: ExtensionGenerationWorkflowSnapshot = deepFreeze({
    sourceId: snapshot.workflow.sourceId,
    instanceId: snapshot.workflow.instanceId,
    revision: snapshot.workflow.revision,
    fingerprint: snapshot.workflow.fingerprint,
    mode: snapshot.workflow.mode,
    nodes: nodeSnapshots,
  });

  const inputNotes: string[] = [];
  const session: ExtensionGenerationSessionSnapshot = deepFreeze({
    workflow,
    status: projectStatus(snapshot.readiness),
    inputs: projectInputs(snapshot.inputs, inputNotes),
    canSubmit: snapshot.submission.canSubmit,
    busy: snapshot.submission.isBusy,
  });

  const projection: GenerationSessionProjection = {
    session,
    truncations:
      inputNotes.length === 0
        ? truncations
        : capNotes([...truncations, ...inputNotes], 0),
  };
  sessionCache = { snapshot, projection };
  return projection;
}

/** Test seam: drop the memoized projections. */
export function resetGenerationSessionProjectionCache(): void {
  workflowCache = null;
  sessionCache = null;
}
