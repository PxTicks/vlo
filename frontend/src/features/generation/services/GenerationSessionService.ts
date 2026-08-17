import {
  indexEditableWidgets,
  validateTextInputCommand,
  validateWidgetCommand,
  widgetKey,
  widgetValueMatchesSnapshot,
} from "./generationSessionValidation";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationInputSnapshot,
  GenerationSessionHost,
  GenerationSessionJsonValue,
  GenerationSessionPublication,
  GenerationSessionSnapshot,
  GenerationSessionTransaction,
  GenerationSessionWidgetCommit,
  GenerationTransactionFailureCode,
  GenerationTransactionResult,
  GenerationWidgetTarget,
} from "./generationSessionTypes";

/**
 * The generation-owned session service
 * (docs/generation-native-extension-seams-plan.md §3.2).
 *
 * It is mounted and unmounted by the generation feature and knows nothing
 * about extensions: no owner binding, no activation lifecycle, no SDK limits.
 * Native panel controls and the trusted extension adapter reach state changes
 * through the same `transaction` implementation, so both get the same
 * validation, the same atomicity, and the same failure codes.
 */

const MAX_LABEL_LENGTH = 120;

interface StagedTextCommand {
  readonly kind: "text";
  readonly inputId: string;
  readonly value: string;
}

interface StagedWidgetCommand {
  readonly kind: "widget";
  readonly target: GenerationWidgetTarget;
  readonly value: unknown;
}

type StagedCommand = StagedTextCommand | StagedWidgetCommand;

function failure(
  label: string,
  code: GenerationTransactionFailureCode,
  message: string,
): GenerationTransactionResult {
  return { ok: false, code, message, label };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function sameOptions(
  left: readonly (string | number | boolean)[] | null,
  right: readonly (string | number | boolean)[] | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((option, index) => Object.is(option, right[index]));
}

/**
 * Every field validation reads has to take part in this comparison — a widget
 * whose constraints changed but whose value did not must still republish, or
 * `transaction` keeps judging writes against the old constraints.
 */
function sameEditableWidgets(
  left: readonly GenerationEditableWidgetSnapshot[],
  right: readonly GenerationEditableWidgetSnapshot[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((widget, index) => {
    const other = right[index];
    return (
      widget.target.nodeId === other.target.nodeId &&
      widget.target.widget === other.target.widget &&
      widget.valueType === other.valueType &&
      Object.is(widget.value, other.value) &&
      widget.min === other.min &&
      widget.max === other.max &&
      Object.is(widget.trueValue, other.trueValue) &&
      Object.is(widget.falseValue, other.falseValue) &&
      sameOptions(widget.options, other.options)
    );
  });
}

function sameInputs(
  left: readonly GenerationInputSnapshot[],
  right: readonly GenerationInputSnapshot[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((input, index) => {
    const other = right[index];
    return (
      input.id === other.id &&
      input.nodeId === other.nodeId &&
      input.param === other.param &&
      input.label === other.label &&
      input.description === other.description &&
      input.inputType === other.inputType &&
      input.value === other.value
    );
  });
}

function samePublication(
  snapshot: GenerationSessionSnapshot,
  next: GenerationSessionPublication,
): boolean {
  return (
    snapshot.workflow.sourceId === next.sourceId &&
    snapshot.workflow.instanceId === next.instanceId &&
    snapshot.workflow.fingerprint === next.fingerprint &&
    snapshot.workflow.mode === next.mode &&
    snapshot.workflow.nodes === next.nodes &&
    sameInputs(snapshot.inputs, next.inputs) &&
    sameEditableWidgets(snapshot.editableWidgets, next.editableWidgets) &&
    snapshot.readiness.isLoading === next.readiness.isLoading &&
    snapshot.readiness.isReady === next.readiness.isReady &&
    snapshot.submission.isBusy === next.submission.isBusy &&
    snapshot.submission.queuedCount === next.submission.queuedCount
  );
}

/**
 * Has the *mounted workflow* changed, as opposed to a value inside it?
 *
 * Deliberately fingerprint-based rather than node-array-identity based: a
 * re-sync rebuilds the catalogue whenever graph data is replaced, and a widget
 * value moving is not a new workflow. The session revision still advances for
 * those, so a subscriber sees the fresh values either way.
 */
function workflowChanged(
  snapshot: GenerationSessionSnapshot,
  next: GenerationSessionPublication,
): boolean {
  return (
    snapshot.workflow.sourceId !== next.sourceId ||
    snapshot.workflow.instanceId !== next.instanceId ||
    snapshot.workflow.fingerprint !== next.fingerprint ||
    snapshot.workflow.mode !== next.mode
  );
}

export class GenerationSessionService {
  private host: GenerationSessionHost | null = null;
  private snapshot: GenerationSessionSnapshot | null = null;
  private revision = 0;
  private workflowRevision = 0;
  private readonly listeners = new Set<() => void>();

  /**
   * Mount the session. The returned disposer clears the snapshot and notifies
   * subscribers, so a consumer that kept a snapshot can tell it went stale.
   */
  mount(host: GenerationSessionHost): () => void {
    this.host = host;
    return () => {
      if (this.host !== host) return;
      this.host = null;
      if (this.snapshot === null) return;
      this.snapshot = null;
      // Losing the session is a revision change like any other: a
      // `useSyncExternalStore` consumer that snapshots `getRevision` must see
      // a new value here, or it keeps rendering the unmounted session.
      this.revision += 1;
      this.notify();
    };
  }

  isMounted(): boolean {
    return this.host !== null;
  }

  /** Publish the mounted feature's current view. Ignored while unmounted. */
  publish(publication: GenerationSessionPublication): void {
    if (!this.host) return;

    const current = this.snapshot;
    if (current && samePublication(current, publication)) return;

    if (!current || workflowChanged(current, publication)) {
      this.workflowRevision += 1;
    }
    this.revision += 1;

    this.snapshot = Object.freeze({
      revision: this.revision,
      workflow: Object.freeze({
        sourceId: publication.sourceId,
        instanceId: publication.instanceId,
        revision: this.workflowRevision,
        fingerprint: publication.fingerprint,
        mode: publication.mode,
        nodes: publication.nodes,
      }),
      inputs: Object.freeze([...publication.inputs]),
      editableWidgets: Object.freeze([...publication.editableWidgets]),
      readiness: Object.freeze({ ...publication.readiness }),
      submission: Object.freeze({ ...publication.submission }),
    }) as GenerationSessionSnapshot;

    this.notify();
  }

  getSnapshot(): GenerationSessionSnapshot | null {
    return this.snapshot;
  }

  /** Monotonic per-mount revision; changes whenever the snapshot changes. */
  getRevision(): number {
    return this.revision;
  }

  /** Payload-free notification, matching `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Stage commands, validate every one against the current snapshot, then
   * commit them in a single host write. If any command is invalid, none apply.
   */
  transaction(
    label: string,
    callback: (transaction: GenerationSessionTransaction) => void,
  ): GenerationTransactionResult {
    if (typeof label !== "string") {
      return failure("", "invalid_label", "Generation labels must be strings.");
    }
    const normalizedLabel = label.trim();
    if (
      normalizedLabel.length === 0 ||
      normalizedLabel.length > MAX_LABEL_LENGTH
    ) {
      return failure(
        normalizedLabel,
        "invalid_label",
        `Generation labels must contain 1-${MAX_LABEL_LENGTH} characters.`,
      );
    }

    // Pin the transaction to the session it started against. The callback is
    // arbitrary code: it can unmount the panel, remount another one, or switch
    // workflows, and a write staged against one workflow must never land on
    // another — least of all one that happens to reuse the same node ids.
    const host = this.host;
    const startSnapshot = this.snapshot;
    if (!host || !startSnapshot) {
      return failure(
        normalizedLabel,
        "unavailable",
        "The generation panel is not mounted.",
      );
    }

    const staged: StagedCommand[] = [];
    let isOpen = true;
    const transaction: GenerationSessionTransaction = {
      setTextInput: (inputId, value) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        if (typeof inputId !== "string" || inputId.trim().length === 0) {
          throw new Error("Generation input IDs must be non-empty strings.");
        }
        if (typeof value !== "string") {
          throw new Error("Generation text values must be strings.");
        }
        staged.push({ kind: "text", inputId: inputId.trim(), value });
      },
      setWidget: (target, value) => {
        if (!isOpen) throw new Error("The generation transaction is closed.");
        const nodeId =
          typeof target?.nodeId === "string" ? target.nodeId.trim() : "";
        const widget =
          typeof target?.widget === "string" ? target.widget.trim() : "";
        if (nodeId.length === 0 || widget.length === 0) {
          throw new Error(
            "Generation widget targets need a node id and a widget name.",
          );
        }
        staged.push({ kind: "widget", target: { nodeId, widget }, value });
      },
    };

    try {
      const callbackResult = callback(transaction);
      if (isPromiseLike(callbackResult)) {
        return failure(
          normalizedLabel,
          "invalid_command",
          "Generation transactions must be synchronous.",
        );
      }
    } catch (error) {
      return failure(
        normalizedLabel,
        "callback_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      isOpen = false;
    }

    const snapshot = this.snapshot;
    if (this.host !== host || !snapshot) {
      return failure(
        normalizedLabel,
        "unavailable",
        "The generation panel was unmounted while the transaction ran.",
      );
    }
    if (snapshot.workflow.revision !== startSnapshot.workflow.revision) {
      return failure(
        normalizedLabel,
        "workflow_changed",
        "The mounted workflow changed while the transaction ran.",
      );
    }

    // Same workflow, so validate against the snapshot as it stands now: values
    // may have moved under the callback, and the freshest ones are the ones
    // the commit has to agree with.
    const editableIndex = indexEditableWidgets(snapshot.editableWidgets);

    const textInputs = new Map<string, string>();
    const widgetCommits = new Map<string, GenerationSessionWidgetCommit>();
    for (const command of staged) {
      if (command.kind === "text") {
        const result = validateTextInputCommand(snapshot, command.inputId);
        if (!result.ok) {
          return failure(
            normalizedLabel,
            result.failure.code,
            result.failure.message,
          );
        }
        textInputs.set(result.value, command.value);
        continue;
      }

      const result = validateWidgetCommand(
        snapshot,
        editableIndex,
        command.target,
        command.value,
      );
      if (!result.ok) {
        return failure(
          normalizedLabel,
          result.failure.code,
          result.failure.message,
        );
      }
      // Later writes to the same target win, matching the graph bridge's
      // sequential apply order.
      widgetCommits.set(widgetKey(command.target), {
        target: command.target,
        value: result.value,
      });
    }

    const changedTextInputs = new Map<string, string>();
    for (const [inputId, value] of textInputs) {
      const input = snapshot.inputs.find(
        (candidate) => candidate.id === inputId,
      );
      if (input?.value !== value) changedTextInputs.set(inputId, value);
    }

    const widgets = [...widgetCommits.values()];
    const changedWidgets = widgets.filter(
      (commit) =>
        !widgetValueMatchesSnapshot(
          editableIndex,
          commit.target,
          commit.value as GenerationSessionJsonValue,
        ),
    );

    if (changedTextInputs.size === 0 && widgets.length === 0) {
      return { ok: true, changed: false, label: normalizedLabel };
    }

    // Widget writes always reach the host, even when the snapshot already
    // shows the value: the panel owns the live value and dedupes it there,
    // and the snapshot can trail a keystroke by a render.
    host.commit({ textInputs: changedTextInputs, widgets });
    return {
      ok: true,
      changed: changedTextInputs.size > 0 || changedWidgets.length > 0,
      label: normalizedLabel,
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** The single mounted generation session. */
export const generationSessionService = new GenerationSessionService();
