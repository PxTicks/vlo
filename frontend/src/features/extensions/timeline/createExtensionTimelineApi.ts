import type {
  ExtensionApiScope,
  ExtensionPayload,
  ExtensionTimelineApi,
  ExtensionTimelineEntitySnapshot,
  ExtensionTimelineTransformInput,
  ExtensionTimelineTransaction,
  ExtensionTimelineTransactionResult,
  ExtensionPoint2D,
  ExtensionSourceDimensions,
} from "../types";
import {
  commitExtensionTimelineTransaction,
  getExtensionTimelineClips,
  getExtensionTimelineEntities,
  getTimelineClipById,
  type ExtensionTimelineCommand,
} from "../../timeline/api";
import {
  extensionPayloadSchema,
  jsonValueSchema,
} from "../persistence/extensionPayload";
import { extensionPayloadProviderRegistry } from "../persistence/ExtensionPayloadProviderRegistry";
import { TICKS_PER_SECOND } from "../../../core/time/constants";
import { useProjectStore } from "../../project";
import { getProjectDimensions, mediaSecondsToTick } from "../../renderer";
import {
  clipSourceTimeToVisual,
  clipVisualToSourceTime,
} from "../../transformations";
import { extensionClipOverlayRegistry } from "./ExtensionClipOverlayRegistry";

const MAX_TRANSACTION_LABEL_LENGTH = 120;

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive and finite.`);
  }
}

function getExtensionProjectSnapshot() {
  const config = useProjectStore.getState().config;
  const dimensions = getProjectDimensions(config.aspectRatio);
  return Object.freeze({
    ...dimensions,
    fps: config.fps,
    fitMode: config.fitMode,
  });
}

function sourcePointToProject(
  point: ExtensionPoint2D,
  source: ExtensionSourceDimensions,
  fitMode?: "contain" | "cover",
): ExtensionPoint2D {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Source point coordinates must be finite.");
  }
  assertPositiveFinite(source.width, "Source width");
  assertPositiveFinite(source.height, "Source height");
  const project = getExtensionProjectSnapshot();
  const mode = fitMode ?? project.fitMode;
  const scaleX = project.width / source.width;
  const scaleY = project.height / source.height;
  const scale =
    mode === "contain"
      ? Math.min(scaleX, scaleY)
      : Math.max(scaleX, scaleY);
  return Object.freeze({
    x: (point.x - source.width / 2) * scale,
    y: (point.y - source.height / 2) * scale,
  });
}

function requireTimelineClip(clipId: string) {
  const clip = getTimelineClipById(clipId);
  if (!clip) throw new Error(`Timeline clip '${clipId}' was not found.`);
  return clip;
}

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

function assertIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidExtensionTimelineCommandError(`${label} must be non-empty.`);
  }
  const normalized = value.trim();
  if (normalized.length > 200) {
    throw new InvalidExtensionTimelineCommandError(
      `${label} must be at most 200 characters.`,
    );
  }
  return normalized;
}

function cloneTransformInput(
  transform: ExtensionTimelineTransformInput,
  generatedId: string,
) {
  if (typeof transform !== "object" || transform === null) {
    throw new InvalidExtensionTimelineCommandError(
      "upsertTransform requires a transform object.",
    );
  }
  const type = assertIdentifier(transform.type, "Transform type");
  const id = transform.id
    ? assertIdentifier(transform.id, "Transform ID")
    : generatedId;
  const parsedParameters = jsonValueSchema.safeParse(transform.parameters);
  if (
    !parsedParameters.success ||
    typeof parsedParameters.data !== "object" ||
    parsedParameters.data === null ||
    Array.isArray(parsedParameters.data)
  ) {
    throw new InvalidExtensionTimelineCommandError(
      "Transform parameters must be a JSON object.",
    );
  }
  const keyframeTimes = transform.keyframeTimes?.map((time) => {
    if (!Number.isFinite(time)) {
      throw new InvalidExtensionTimelineCommandError(
        "Transform keyframe times must be finite.",
      );
    }
    return time;
  });
  return {
    id,
    type,
    isEnabled: transform.isEnabled ?? true,
    parameters: structuredClone(parsedParameters.data),
    ...(keyframeTimes ? { keyframeTimes } : {}),
    ...(transform.templateId
      ? { templateId: assertIdentifier(transform.templateId, "Template ID") }
      : {}),
    ...(transform.filterName
      ? { filterName: assertIdentifier(transform.filterName, "Filter name") }
      : {}),
  };
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
  const boundClipOverlays = extensionClipOverlayRegistry.bind(scope);
  const api: ExtensionTimelineApi = {
    ticksPerSecond: TICKS_PER_SECOND,
    listEntities: (): readonly ExtensionTimelineEntitySnapshot[] =>
      getExtensionTimelineEntities(scope.extension.id),
    listClips: () => getExtensionTimelineClips(),
    getProject: getExtensionProjectSnapshot,
    sourceFrameToTicks: (frameIndex, sourceFps) => {
      if (!Number.isInteger(frameIndex) || frameIndex < 0) {
        throw new RangeError("Source frame index must be a non-negative integer.");
      }
      assertPositiveFinite(sourceFps, "Source FPS");
      return mediaSecondsToTick(frameIndex / sourceFps);
    },
    clipProgressToSourceTicks: (clipId, progress) => {
      if (!Number.isFinite(progress)) {
        throw new RangeError("Clip progress must be finite.");
      }
      const clip = requireTimelineClip(clipId);
      return clipVisualToSourceTime(
        clip,
        Math.max(0, Math.min(1, progress)) * clip.timelineDuration,
      );
    },
    sourceTicksToClipProgress: (clipId, sourceTimeTicks) => {
      if (!Number.isFinite(sourceTimeTicks)) {
        throw new RangeError("Source time must be finite.");
      }
      const clip = requireTimelineClip(clipId);
      if (clip.timelineDuration <= 0) return 0;
      return Math.max(
        0,
        Math.min(
          1,
          clipSourceTimeToVisual(clip, sourceTimeTicks) / clip.timelineDuration,
        ),
      );
    },
    sourcePointToProject,

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
        upsertTransform: (clipId, transform) => {
          assertOpen();
          const normalizedClipId = assertIdentifier(clipId, "Clip ID");
          const generatedId = `extension_transform_${crypto.randomUUID()}`;
          const cloned = cloneTransformInput(transform, generatedId);
          commands.push({
            kind: "upsert_transform",
            clipId: normalizedClipId,
            transform: cloned,
          });
          return cloned.id;
        },
        removeTransform: (clipId, transformId) => {
          assertOpen();
          commands.push({
            kind: "remove_transform",
            clipId: assertIdentifier(clipId, "Clip ID"),
            transformId: assertIdentifier(transformId, "Transform ID"),
          });
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

    registerClipOverlay: (definition) => boundClipOverlays.register(definition),
  };
  return Object.freeze(api);
}
