import type {
  ExtensionApiScope,
  ExtensionPayload,
  ExtensionTimelineApi,
  ExtensionTimelineEntitySnapshot,
  ExtensionTimelineTransaction,
  ExtensionTimelineTransactionResult,
} from "../types";
import {
  commitExtensionTimelineTransaction,
  getExtensionTimelineEntities,
  type ExtensionTimelineCommand,
} from "../../timeline/api";
import { extensionPayloadSchema } from "../persistence/extensionPayload";
import { extensionPayloadProviderRegistry } from "../persistence/ExtensionPayloadProviderRegistry";
import { TICKS_PER_SECOND } from "../../../core/time/constants";

const MAX_TRANSACTION_LABEL_LENGTH = 120;

class InvalidExtensionTimelineCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExtensionTimelineCommandError";
  }
}

function failedTransaction(
  label: string,
  code: "invalid_label" | "invalid_command" | "callback_failed",
  error: unknown,
): ExtensionTimelineTransactionResult {
  return {
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
    label,
  };
}

function assertEntityId(entityId: string): void {
  if (typeof entityId !== "string" || entityId.trim().length === 0) {
    throw new InvalidExtensionTimelineCommandError(
      "Extension timeline commands require a non-empty entity ID.",
    );
  }
}

function clonePayload(payload: ExtensionPayload): ExtensionPayload {
  const parsed = extensionPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidExtensionTimelineCommandError(
      `Invalid extension payload: ${parsed.error.message}`,
    );
  }
  const assetResolution =
    extensionPayloadProviderRegistry.resolveAssetReferences(parsed.data);
  if (assetResolution.ok) {
    return structuredClone(assetResolution.payload);
  }
  if (assetResolution.resolution.status !== "missing") {
    throw new InvalidExtensionTimelineCommandError(
      assetResolution.resolution.error.message,
    );
  }
  return structuredClone(parsed.data);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function createExtensionTimelineApi(
  scope: ExtensionApiScope,
): ExtensionTimelineApi {
  const api: ExtensionTimelineApi = {
    ticksPerSecond: TICKS_PER_SECOND,
    listEntities: (): readonly ExtensionTimelineEntitySnapshot[] =>
      getExtensionTimelineEntities(scope.extension.id),

    transaction: (label, callback): ExtensionTimelineTransactionResult => {
      if (typeof label !== "string") {
        return failedTransaction(
          "",
          "invalid_label",
          new Error("Transaction labels must be strings."),
        );
      }
      const normalizedLabel = label.trim();
      if (
        normalizedLabel.length === 0 ||
        normalizedLabel.length > MAX_TRANSACTION_LABEL_LENGTH
      ) {
        return failedTransaction(
          normalizedLabel,
          "invalid_label",
          new Error(
            `Transaction labels must contain 1-${MAX_TRANSACTION_LABEL_LENGTH} characters.`,
          ),
        );
      }

      const commands: ExtensionTimelineCommand[] = [];
      let isOpen = true;
      const assertOpen = () => {
        if (!isOpen) {
          throw new InvalidExtensionTimelineCommandError(
            "The extension timeline transaction is already closed.",
          );
        }
      };
      const transaction: ExtensionTimelineTransaction = {
        createEntity: (input) => {
          assertOpen();
          if (typeof input !== "object" || input === null) {
            throw new InvalidExtensionTimelineCommandError(
              "createEntity requires an input object.",
            );
          }
          if (typeof input.name !== "string") {
            throw new InvalidExtensionTimelineCommandError(
              "Entity names must be strings.",
            );
          }
          const name = input.name.trim();
          if (name.length === 0 || name.length > 200) {
            throw new InvalidExtensionTimelineCommandError(
              "Entity names must contain 1-200 characters.",
            );
          }
          if (!Number.isFinite(input.startTicks) || input.startTicks < 0) {
            throw new InvalidExtensionTimelineCommandError(
              "Entity startTicks must be a finite non-negative number.",
            );
          }
          if (!Number.isFinite(input.durationTicks) || input.durationTicks <= 0) {
            throw new InvalidExtensionTimelineCommandError(
              "Entity durationTicks must be a finite positive number.",
            );
          }
          if (
            input.trackId !== undefined &&
            (typeof input.trackId !== "string" ||
              input.trackId.trim().length === 0)
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "Entity trackId must be non-empty when supplied.",
            );
          }
          const payload = clonePayload(input.payload);
          const entityId = `extension_${crypto.randomUUID()}`;
          commands.push({
            kind: "create_entity",
            entityId,
            name,
            trackId: input.trackId?.trim(),
            startTicks: Math.round(input.startTicks),
            durationTicks: Math.max(1, Math.round(input.durationTicks)),
            payload,
          });
          return entityId;
        },
        updatePayload: (entityId, payload) => {
          assertOpen();
          assertEntityId(entityId);
          commands.push({
            kind: "update_payload",
            entityId,
            payload: clonePayload(payload),
          });
        },
        moveEntity: (entityId, placement) => {
          assertOpen();
          assertEntityId(entityId);
          if (
            placement.startTicks !== undefined &&
            (!Number.isFinite(placement.startTicks) || placement.startTicks < 0)
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "Entity startTicks must be a finite non-negative number.",
            );
          }
          if (
            placement.trackId !== undefined &&
            placement.trackId.trim().length === 0
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "Entity trackId must be non-empty when supplied.",
            );
          }
          if (
            placement.startTicks === undefined &&
            placement.trackId === undefined
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "moveEntity requires startTicks, trackId, or both.",
            );
          }
          commands.push({
            kind: "move_entity",
            entityId,
            startTicks:
              placement.startTicks === undefined
                ? undefined
                : Math.round(placement.startTicks),
            trackId: placement.trackId,
          });
        },
        removeEntity: (entityId) => {
          assertOpen();
          assertEntityId(entityId);
          commands.push({ kind: "remove_entity", entityId });
        },
      };
      Object.freeze(transaction);

      try {
        const callbackResult: unknown = callback(transaction);
        if (isPromiseLike(callbackResult)) {
          void Promise.resolve(callbackResult).catch((error: unknown) => {
            scope.report(
              "error",
              "An asynchronous timeline transaction callback failed after it was rejected.",
              error,
            );
          });
          throw new InvalidExtensionTimelineCommandError(
            "Extension timeline transactions must be synchronous.",
          );
        }
      } catch (error) {
        const code =
          error instanceof InvalidExtensionTimelineCommandError
            ? "invalid_command"
            : "callback_failed";
        return failedTransaction(normalizedLabel, code, error);
      } finally {
        isOpen = false;
      }

      return commitExtensionTimelineTransaction(
        normalizedLabel,
        scope.extension.id,
        commands,
      );
    },
  };
  return Object.freeze(api);
}
