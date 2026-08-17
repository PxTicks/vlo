import { generationSessionService } from "../../generation/services/GenerationSessionService";
import { serializeFiniteJson } from "../../generation/utils/finiteJson";
import type {
  GenerationTransactionResult,
  GenerationTransactionFailureCode,
} from "../../generation/services/generationSessionTypes";
import type {
  ExtensionApiScope,
  ExtensionGenerationApi,
  ExtensionGenerationInputSnapshot,
  ExtensionGenerationTransaction,
  ExtensionGenerationTransactionResult,
} from "../types";

/**
 * The extension adapter over the generation session
 * (docs/generation-native-extension-seams-plan.md §4).
 *
 * Everything owner-specific lives here: activation scope, SDK size limits,
 * finite-JSON checks on untrusted input, defensive cloning, and translation of
 * the host's failure codes into the public ones. The staging, validation, and
 * atomic commit are the generation feature's, shared with the native panel.
 */

const MAX_LABEL_LENGTH = 120;
const MAX_TEXT_VALUE_LENGTH = 1_000_000;

type PublicFailureCode = Exclude<
  ExtensionGenerationTransactionResult,
  { readonly ok: true }
>["code"];

/**
 * Host failure code → published failure code.
 *
 * Failure codes the SDK does not publish yet (widget writes are not part of the
 * extension surface) collapse onto `invalid_command`, so an adapter-side bug can
 * never leak an unmodelled code to an extension. `Record` over the host union
 * makes a newly added host code a compile error here rather than a runtime
 * `undefined` on the wire.
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
  widget_not_found: "invalid_command",
  widget_not_editable: "invalid_command",
  widget_value_invalid: "invalid_command",
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
  const api: ExtensionGenerationApi = {
    listInputs: () => {
      if (scope.signal.aborted) return [];
      return Object.freeze(
        listInputSnapshots().map((input) =>
          Object.freeze(structuredClone(input)),
        ),
      );
    },
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
