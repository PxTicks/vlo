import type {
  ExtensionApiScope,
  ExtensionGenerationApi,
  ExtensionGenerationInputSnapshot,
  ExtensionGenerationTransaction,
  ExtensionGenerationTransactionResult,
} from "../types";

const MAX_LABEL_LENGTH = 120;
const MAX_TEXT_VALUE_LENGTH = 1_000_000;

export interface ExtensionGenerationHostAdapter {
  listInputs(): readonly ExtensionGenerationInputSnapshot[];
  commitTextInputs(updates: ReadonlyMap<string, string>): void;
}

class ExtensionGenerationBridge {
  private adapter: ExtensionGenerationHostAdapter | null = null;

  mount(adapter: ExtensionGenerationHostAdapter): () => void {
    this.adapter = adapter;
    return () => {
      if (this.adapter === adapter) this.adapter = null;
    };
  }

  getAdapter(): ExtensionGenerationHostAdapter | null {
    return this.adapter;
  }
}

export const extensionGenerationBridge = new ExtensionGenerationBridge();

function failure(
  label: string,
  code: Exclude<
    ExtensionGenerationTransactionResult,
    { readonly ok: true }
  >["code"],
  message: string,
): ExtensionGenerationTransactionResult {
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

export function createExtensionGenerationApi(
  scope: ExtensionApiScope,
): ExtensionGenerationApi {
  const api: ExtensionGenerationApi = {
    listInputs: () => {
      if (scope.signal.aborted) return [];
      const inputs = extensionGenerationBridge.getAdapter()?.listInputs() ?? [];
      return Object.freeze(inputs.map((input) => Object.freeze(structuredClone(input))));
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
      const adapter = extensionGenerationBridge.getAdapter();
      if (!adapter) {
        return failure(
          normalizedLabel,
          "unavailable",
          "The generation panel is not mounted.",
        );
      }

      const updates = new Map<string, string>();
      let isOpen = true;
      const transaction: ExtensionGenerationTransaction = {
        setTextInput: (inputId, value) => {
          if (!isOpen) throw new Error("The generation transaction is closed.");
          if (typeof inputId !== "string" || inputId.trim().length === 0) {
            throw new Error("Generation input IDs must be non-empty strings.");
          }
          if (typeof value !== "string" || value.length > MAX_TEXT_VALUE_LENGTH) {
            throw new Error(
              `Generation text values must contain at most ${MAX_TEXT_VALUE_LENGTH} characters.`,
            );
          }
          updates.set(inputId.trim(), value);
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

      const inputs = new Map(adapter.listInputs().map((input) => [input.id, input]));
      for (const inputId of updates.keys()) {
        const input = inputs.get(inputId);
        if (!input) {
          return failure(
            normalizedLabel,
            "input_not_found",
            `Generation input '${inputId}' was not found.`,
          );
        }
        if (input.inputType !== "text") {
          return failure(
            normalizedLabel,
            "input_type_mismatch",
            `Generation input '${inputId}' is not a text input.`,
          );
        }
      }
      const changed = [...updates].some(
        ([inputId, value]) => inputs.get(inputId)?.value !== value,
      );
      if (changed) adapter.commitTextInputs(updates);
      return { ok: true, changed, label: normalizedLabel };
    },
  };
  return Object.freeze(api);
}
