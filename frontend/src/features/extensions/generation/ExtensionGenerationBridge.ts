import { generationSessionService } from "../../generation/services/GenerationSessionService";
import { serializeFiniteJson } from "../../generation/utils/finiteJson";
import type { RevisionSource } from "../../../core/shell/revisionRelay";
import type {
  GenerationTransactionResult,
  GenerationTransactionFailureCode,
} from "../../generation/services/generationSessionTypes";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import { projectGenerationSession } from "./generationSessionProjection";
import type {
  ExtensionApiScope,
  ExtensionGenerationApi,
  ExtensionGenerationInputSnapshot,
  ExtensionGenerationSessionSnapshot,
  ExtensionGenerationTransaction,
  ExtensionGenerationTransactionResult,
} from "../types";

/**
 * The extension adapter over the generation session
 * (docs/generation-native-extension-seams-plan.md §4,
 * docs/generation-extension-surface-plan.md E1).
 *
 * Everything owner-specific lives here: activation scope, SDK size limits,
 * finite-JSON checks on untrusted input, defensive cloning, and translation of
 * the host's failure codes into the public ones. The staging, validation, and
 * atomic commit are the generation feature's, shared with the native panel.
 */

const MAX_LABEL_LENGTH = 120;
const MAX_TEXT_VALUE_LENGTH = 1_000_000;
const MAX_TARGET_PART_LENGTH = 512;
/**
 * A widget write is a scalar or a small structure, never a payload: the panel's
 * own controls emit strings, numbers, and booleans. Bounding it here keeps an
 * extension from making the host validate — and the graph bridge apply — an
 * arbitrarily large blob.
 */
const MAX_WIDGET_VALUE_LENGTH = 100_000;

/**
 * The session's own change signal. The service is already payload-free and
 * revision-based, so it is a `RevisionSource` as it stands; the adapter only
 * adds owner scoping around it.
 */
const generationSessionSignal: RevisionSource = Object.freeze({
  subscribe: (listener: () => void) =>
    generationSessionService.subscribe(listener),
  getRevision: () => generationSessionService.getRevision(),
});

type PublicFailureCode = Exclude<
  ExtensionGenerationTransactionResult,
  { readonly ok: true }
>["code"];

/**
 * Host failure code → published failure code.
 *
 * Codes the SDK does not publish collapse onto a published one, so an
 * adapter-side bug can never leak an unmodelled code to an extension. `Record`
 * over the host union makes a newly added host code a compile error here rather
 * than a runtime `undefined` on the wire.
 *
 * The three widget codes are published as themselves since E1: an extension
 * that cannot tell "no such widget" from "the panel exposes no control for it"
 * from "that value is out of range" has no way to decide whether to fall back,
 * and would have to guess by re-trying.
 *
 * Exported for the N3 boundary test, which pins every entry — the translation
 * is a published contract, not an implementation detail
 * (docs/generation-native-extension-seams-plan.md §5, N3).
 */
export const PUBLIC_FAILURE_CODES: Record<
  GenerationTransactionFailureCode,
  PublicFailureCode
> = {
  invalid_label: "invalid_label",
  unavailable: "unavailable",
  // A workflow switch under the callback leaves the session the extension
  // addressed unreachable, which is what `unavailable` means publicly.
  workflow_changed: "unavailable",
  invalid_command: "invalid_command",
  callback_failed: "callback_failed",
  input_not_found: "input_not_found",
  input_type_mismatch: "input_type_mismatch",
  widget_not_found: "widget_not_found",
  widget_not_editable: "widget_not_editable",
  widget_value_invalid: "widget_value_invalid",
};

function failure(
  label: string,
  code: PublicFailureCode,
  message: string,
): ExtensionGenerationTransactionResult {
  return { ok: false, code, message, label };
}

function toPublicResult(
  result: GenerationTransactionResult,
): ExtensionGenerationTransactionResult {
  if (result.ok) {
    return { ok: true, changed: result.changed, label: result.label };
  }
  return failure(
    result.label,
    PUBLIC_FAILURE_CODES[result.code],
    result.message,
  );
}

function listInputSnapshots(): readonly ExtensionGenerationInputSnapshot[] {
  const snapshot = generationSessionService.getSnapshot();
  if (!snapshot) return [];
  return snapshot.inputs.map((input) => ({
    id: input.id,
    nodeId: input.nodeId,
    param: input.param,
    label: input.label,
    ...(input.description ? { description: input.description } : {}),
    inputType: input.inputType,
    ...(input.value !== undefined ? { value: input.value } : {}),
  }));
}

export function createExtensionGenerationApi(
  scope: ExtensionApiScope,
): ExtensionGenerationApi {
  // Truncation is reported once per revision per owner: the projection is
  // memoized and shared, so reporting inside it would either say nothing after
  // the first owner asked, or say it again on every render.
  let reportedTruncationRevision: number | null = null;

  const readSession = (): ExtensionGenerationSessionSnapshot | null => {
    if (scope.signal.aborted) return null;
    const snapshot = generationSessionService.getSnapshot();
    if (!snapshot) return null;
    const { session, truncations } = projectGenerationSession(snapshot);
    if (
      truncations.length > 0 &&
      reportedTruncationRevision !== snapshot.revision
    ) {
      reportedTruncationRevision = snapshot.revision;
      scope.report(
        "warning",
        "The generation session snapshot was truncated to its published limits.",
        truncations,
      );
    }
    return session;
  };

  const api: ExtensionGenerationApi = {
    listInputs: () => {
      if (scope.signal.aborted) return [];
      return Object.freeze(
        listInputSnapshots().map((input) =>
          Object.freeze(structuredClone(input)),
        ),
      );
    },
    getSession: readSession,
    // Zero once the activation has ended, matching the empty reads above: a
    // component still mounted over a disposed API sees one stable value rather
    // than a session it can no longer read moving underneath it.
    getRevision: () =>
      scope.signal.aborted ? 0 : generationSessionService.getRevision(),
    subscribe: bindOwnerScopedSubscribe(
      scope,
      generationSessionSignal,
      "Generation session",
    ),
    transaction: (label, callback) => {
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
      if (scope.signal.aborted) {
        return failure(
          normalizedLabel,
          "unavailable",
          "The extension activation has ended.",
        );
      }
      if (!generationSessionService.getSnapshot()) {
        return failure(
          normalizedLabel,
          "unavailable",
          "The generation panel is not mounted.",
        );
      }

      return toPublicResult(
        generationSessionService.transaction(normalizedLabel, (session) => {
          const transaction: ExtensionGenerationTransaction = {
            setTextInput: (inputId, value) => {
              if (typeof inputId !== "string" || inputId.trim().length === 0) {
                throw new Error(
                  "Generation input IDs must be non-empty strings.",
                );
              }
              if (
                typeof value !== "string" ||
                value.length > MAX_TEXT_VALUE_LENGTH ||
                serializeFiniteJson(value) === null
              ) {
                throw new Error(
                  `Generation text values must contain at most ${MAX_TEXT_VALUE_LENGTH} characters.`,
                );
              }
              session.setTextInput(inputId, value);
            },
            setWidget: (target, value) => {
              const nodeId =
                typeof target?.nodeId === "string" ? target.nodeId : "";
              const widget =
                typeof target?.widget === "string" ? target.widget : "";
              if (
                nodeId.trim().length === 0 ||
                widget.trim().length === 0 ||
                nodeId.length > MAX_TARGET_PART_LENGTH ||
                widget.length > MAX_TARGET_PART_LENGTH
              ) {
                throw new Error(
                  `Generation widget targets need a node id and a widget name of at most ${MAX_TARGET_PART_LENGTH} characters.`,
                );
              }
              // Finite JSON and bounded *before* the host sees it. The host
              // validates the value against the widget; the adapter validates
              // that it is a value at all, because an SDK caller is untrusted
              // input and a native control is not.
              const serialized = serializeFiniteJson(value);
              if (
                serialized === null ||
                serialized.length > MAX_WIDGET_VALUE_LENGTH
              ) {
                throw new Error(
                  `Generation widget values must be finite JSON of at most ${MAX_WIDGET_VALUE_LENGTH} serialized characters.`,
                );
              }
              session.setWidget(
                { nodeId, widget },
                JSON.parse(serialized) as unknown,
              );
            },
          };
          // Returned so the session still sees an async callback and refuses
          // it; the SDK contract is synchronous.
          return callback(transaction);
        }),
      );
    },
  };
  return Object.freeze(api);
}
