import type {
  ExtensionApiScope,
  ExtensionPayload,
  ExtensionTimelineApi,
  ExtensionTimelineEntitySnapshot,
  ExtensionTimelineMaskCreateInput,
  ExtensionTimelineTransformInput,
  ExtensionTimelineTransaction,
  ExtensionTimelineTransactionFailureCode,
  ExtensionTimelineTransactionOptions,
  ExtensionTimelineTransactionResult,
  ExtensionPoint2D,
  ExtensionSourceDimensions,
  JsonValue,
} from "../types";
import {
  commitExtensionTimelineTransaction,
  createExtensionMaskLocalId,
  getExtensionTimelineClipMasks,
  getExtensionTimelineClips,
  getExtensionTimelineEntities,
  getExtensionTimelineTracks,
  getExtensionTimelineTransitions,
  createTimelineClipFromAsset,
  getTimelineClipById,
  getTimelineStoreForTrustedHostAccess,
  getTimelineTransitions,
  type ExtensionTimelineCommand,
} from "../../timeline/api";
import {
  combineRevisionSources,
  createRevisionRelay,
} from "../../../core/shell/revisionRelay";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
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
} from "../../transformations/utils/clipTimeDomains";
import { extensionClipOverlayRegistry } from "./ExtensionClipOverlayRegistry";
import { extensionTransitionRegistry } from "../../transitions/extensions/ExtensionTransitionRegistry";
import type { TimelineClip, Transition } from "../../../types/TimelineTypes";
import type {
  ClipMask,
  ClipMaskParameters,
  ClipMaskType,
  MaskActiveRange,
} from "../../../types/TimelineTypes";
import { createMask } from "../../masks/model/maskFactory";
import { getAssetById } from "../../userAssets/api";

const MAX_TRANSACTION_LABEL_LENGTH = 120;
const MAX_COALESCE_KEY_LENGTH = 120;
const SUPPORTED_MASK_TYPES = new Set<ClipMaskType>([
  "circle",
  "rectangle",
  "triangle",
  "sam2",
  "generation",
  "brush",
]);
const BITMAP_MASK_TYPES = new Set<ClipMaskType>([
  "sam2",
  "generation",
  "brush",
]);

// Commit-grained model signal: selection and interaction updates keep these
// references stable, so only committed timeline changes (undo/redo included)
// bump the revision.
const timelineModelRelay = createRevisionRelay(
  getTimelineStoreForTrustedHostAccess(),
  (state) => [state.clips, state.tracks, state.transitions],
);

// `getProject()` reads the project store, not the timeline store, so the model
// relay alone would leave width/height/fps/fitMode changes silent: an extension
// caching project dimensions would go stale whenever the user changed the
// aspect ratio, frame rate, or fit mode. Watch exactly the config fields the
// snapshot surfaces — other config (layout mode, browser display) is not part
// of this API and must not signal.
const projectSnapshotRelay = createRevisionRelay(useProjectStore, (state) => [
  state.config.aspectRatio,
  state.config.fps,
  state.config.fitMode,
]);

const timelineRevisionRelay = combineRevisionSources(
  timelineModelRelay,
  projectSnapshotRelay,
);

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
  readonly code: ExtensionTimelineTransactionFailureCode;

  constructor(
    message: string,
    code: ExtensionTimelineTransactionFailureCode = "invalid_command",
  ) {
    super(message);
    this.name = "InvalidExtensionTimelineCommandError";
    this.code = code;
  }
}

function failedTransaction(
  label: string,
  code: ExtensionTimelineTransactionFailureCode,
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

function assertFiniteTick(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidExtensionTimelineCommandError(
      `${label} must be a finite non-negative number.`,
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

function cloneJsonObjectInput(
  value: unknown,
  label: string,
): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    throw new InvalidExtensionTimelineCommandError(
      `${label} must be a JSON object.`,
    );
  }
  return structuredClone(parsed.data) as Record<string, JsonValue>;
}

function cloneMaskParameters(value: unknown): ClipMaskParameters {
  const parameters = cloneJsonObjectInput(value, "Mask parameters");
  const baseWidth = parameters.baseWidth;
  const baseHeight = parameters.baseHeight;
  if (
    typeof baseWidth !== "number" ||
    !Number.isFinite(baseWidth) ||
    baseWidth <= 0 ||
    typeof baseHeight !== "number" ||
    !Number.isFinite(baseHeight) ||
    baseHeight <= 0
  ) {
    throw new InvalidExtensionTimelineCommandError(
      "Mask parameters require positive finite baseWidth and baseHeight values.",
    );
  }
  return { baseWidth, baseHeight };
}

function cloneMaskRange(
  range: { readonly startSourceTicks: number; readonly endSourceTicks: number },
): MaskActiveRange {
  if (
    !Number.isFinite(range.startSourceTicks) ||
    !Number.isFinite(range.endSourceTicks) ||
    range.startSourceTicks < 0 ||
    range.endSourceTicks <= range.startSourceTicks
  ) {
    throw new InvalidExtensionTimelineCommandError(
      "Mask active ranges require finite non-negative ticks with end after start.",
    );
  }
  return {
    startSourceTicks: Math.round(range.startSourceTicks),
    endSourceTicks: Math.round(range.endSourceTicks),
  };
}

function cloneMaskInput(
  input: ExtensionTimelineMaskCreateInput,
  generatedId: string,
): { readonly mask: ClipMask; readonly name?: string } {
  if (typeof input !== "object" || input === null) {
    throw new InvalidExtensionTimelineCommandError(
      "addClipMask requires an input object.",
    );
  }
  const maskType = assertIdentifier(input.maskType, "Mask type") as ClipMaskType;
  if (!SUPPORTED_MASK_TYPES.has(maskType)) {
    throw new InvalidExtensionTimelineCommandError(
      `Mask type '${maskType}' is not supported.`,
      "mask_type_not_supported",
    );
  }
  const name = input.name?.trim();
  if (input.name !== undefined && (!name || name.length > 200)) {
    throw new InvalidExtensionTimelineCommandError(
      "Mask names must contain 1-200 characters when supplied.",
    );
  }
  if (
    input.mode !== undefined &&
    input.mode !== "apply" &&
    input.mode !== "preview"
  ) {
    throw new InvalidExtensionTimelineCommandError(
      "Mask mode must be 'apply' or 'preview'.",
    );
  }
  if (input.inverted !== undefined && typeof input.inverted !== "boolean") {
    throw new InvalidExtensionTimelineCommandError(
      "Mask inverted must be a boolean when supplied.",
    );
  }
  const parameters = cloneMaskParameters(input.parameters);
  const assetId = input.assetId
    ? assertIdentifier(input.assetId, "Mask asset ID")
    : undefined;
  if (BITMAP_MASK_TYPES.has(maskType) && !assetId) {
    throw new InvalidExtensionTimelineCommandError(
      `Mask type '${maskType}' requires an ingested image assetId.`,
    );
  }
  if (assetId) {
    const asset = getAssetById(assetId);
    if (!asset || asset.type !== "image") {
      throw new InvalidExtensionTimelineCommandError(
        `Mask asset '${assetId}' was not found or is not an image.`,
      );
    }
  }
  if (assetId && !BITMAP_MASK_TYPES.has(maskType)) {
    throw new InvalidExtensionTimelineCommandError(
      `Mask type '${maskType}' does not accept an assetId.`,
    );
  }
  const paintedBounds = input.paintedBounds
    ? {
        x: input.paintedBounds.x,
        y: input.paintedBounds.y,
        width: input.paintedBounds.width,
        height: input.paintedBounds.height,
      }
    : undefined;
  if (
    paintedBounds &&
    (!Object.values(paintedBounds).every(Number.isFinite) ||
      paintedBounds.width <= 0 ||
      paintedBounds.height <= 0)
  ) {
    throw new InvalidExtensionTimelineCommandError(
      "Mask painted bounds must be finite with positive width and height.",
    );
  }
  if (paintedBounds && maskType !== "brush") {
    throw new InvalidExtensionTimelineCommandError(
      "Painted bounds are only valid for brush masks.",
    );
  }
  const mask = createMask(maskType, {
    id: generatedId,
    mode: input.mode,
    inverted: input.inverted,
    parameters,
    ...(maskType === "sam2" ? { sam2MaskAssetId: assetId } : {}),
    ...(maskType === "brush"
      ? { brushMaskAssetId: assetId, brushPaintedBounds: paintedBounds }
      : {}),
    ...(input.activeRange
      ? { activeRange: cloneMaskRange(input.activeRange) }
      : {}),
  });
  if (maskType === "generation") mask.generationMaskAssetId = assetId;
  return { mask, ...(name ? { name } : {}) };
}

function cloneTransactionOptions(
  options: ExtensionTimelineTransactionOptions | undefined,
): ExtensionTimelineTransactionOptions | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null) {
    throw new InvalidExtensionTimelineCommandError(
      "Timeline transaction options must be an object.",
    );
  }
  if (options.coalesce === undefined) return Object.freeze({});
  if (typeof options.coalesce !== "object" || options.coalesce === null) {
    throw new InvalidExtensionTimelineCommandError(
      "Timeline transaction coalesce must be an object.",
    );
  }
  const coalesceKey = assertIdentifier(options.coalesce.key, "Coalescing key");
  if (coalesceKey.length > MAX_COALESCE_KEY_LENGTH) {
    throw new InvalidExtensionTimelineCommandError(
      `Coalescing keys must be at most ${MAX_COALESCE_KEY_LENGTH} characters.`,
    );
  }
  if (
    options.coalesce.phase !== "continue" &&
    options.coalesce.phase !== "end"
  ) {
    throw new InvalidExtensionTimelineCommandError(
      "Timeline transaction coalescing phase must be 'continue' or 'end'.",
    );
  }
  return Object.freeze({
    coalesce: Object.freeze({
      key: coalesceKey,
      phase: options.coalesce.phase,
    }),
  });
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

function transitionOwnerId(type: string): string | null {
  const separatorIndex = type.indexOf("/");
  return separatorIndex > 0 ? type.slice(0, separatorIndex) : null;
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
    listTracks: () => getExtensionTimelineTracks(),
    listTransitions: () => getExtensionTimelineTransitions(),
    listClipMasks: (clipId) => getExtensionTimelineClipMasks(clipId),
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

    transaction: (
      label,
      callback,
      options,
    ): ExtensionTimelineTransactionResult => {
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

      let normalizedOptions: ExtensionTimelineTransactionOptions | undefined;
      try {
        normalizedOptions = cloneTransactionOptions(options);
      } catch (error) {
        return failedTransaction(normalizedLabel, "invalid_command", error);
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
        // Clip and track commands carry shape checks only. Every structural
        // rule — overlap, trim limits, track class, removal cascades — is
        // enforced by the host applier, out of the extension's reach.
        createClip: (input) => {
          assertOpen();
          if (typeof input !== "object" || input === null) {
            throw new InvalidExtensionTimelineCommandError(
              "createClip requires an input object.",
            );
          }
          const assetId = assertIdentifier(input.assetId, "Asset ID");
          assertFiniteTick(input.startTicks, "Clip startTicks");
          const asset = getAssetById(assetId);
          if (!asset) {
            throw new InvalidExtensionTimelineCommandError(
              `Project asset '${assetId}' was not found.`,
              "asset_not_found",
            );
          }
          if (asset.type === "lut") {
            throw new InvalidExtensionTimelineCommandError(
              `Asset '${assetId}' is a LUT and cannot be placed as a clip.`,
            );
          }
          // The host derives the clip from the asset's own media properties;
          // the extension contributes placement only. Track choice and final
          // position stay with the applier.
          const clipId = `extension_clip_${crypto.randomUUID()}`;
          const clip = {
            ...createTimelineClipFromAsset(asset),
            id: clipId,
            ...(input.name === undefined
              ? {}
              : { name: assertIdentifier(input.name, "Clip name") }),
            trackId: input.trackId ?? "",
            start: Math.round(input.startTicks),
          } as TimelineClip;
          // A generated asset carries its matte as a separate asset; place it
          // with the clip so the result matches a host-placed copy.
          const creation = asset.creationMetadata;
          const generationMaskAssetId =
            creation?.source === "generated"
              ? creation.generationMaskAssetId
              : undefined;
          commands.push({
            kind: "create_clip",
            clip,
            ...(input.trackId === undefined
              ? {}
              : { trackId: assertIdentifier(input.trackId, "Track ID") }),
            ...(generationMaskAssetId ? { generationMaskAssetId } : {}),
          });
          return clipId;
        },
        moveClip: (clipId, placement) => {
          assertOpen();
          const normalizedClipId = assertIdentifier(clipId, "Clip ID");
          if (typeof placement !== "object" || placement === null) {
            throw new InvalidExtensionTimelineCommandError(
              "moveClip requires a placement object.",
            );
          }
          if (
            placement.startTicks === undefined &&
            placement.trackId === undefined
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "moveClip requires startTicks, trackId, or both.",
            );
          }
          if (placement.startTicks !== undefined) {
            assertFiniteTick(placement.startTicks, "Clip startTicks");
          }
          commands.push({
            kind: "move_clip",
            clipId: normalizedClipId,
            ...(placement.startTicks === undefined
              ? {}
              : { startTicks: Math.round(placement.startTicks) }),
            ...(placement.trackId === undefined
              ? {}
              : { trackId: assertIdentifier(placement.trackId, "Track ID") }),
          });
        },
        trimClip: (clipId, trim) => {
          assertOpen();
          const normalizedClipId = assertIdentifier(clipId, "Clip ID");
          if (typeof trim !== "object" || trim === null) {
            throw new InvalidExtensionTimelineCommandError(
              "trimClip requires a trim object.",
            );
          }
          if (trim.startTicks === undefined && trim.endTicks === undefined) {
            throw new InvalidExtensionTimelineCommandError(
              "trimClip requires startTicks, endTicks, or both.",
            );
          }
          if (trim.startTicks !== undefined) {
            assertFiniteTick(trim.startTicks, "Clip startTicks");
          }
          if (trim.endTicks !== undefined) {
            assertFiniteTick(trim.endTicks, "Clip endTicks");
          }
          if (
            trim.startTicks !== undefined &&
            trim.endTicks !== undefined &&
            trim.endTicks <= trim.startTicks
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "trimClip endTicks must be greater than startTicks.",
            );
          }
          commands.push({
            kind: "trim_clip",
            clipId: normalizedClipId,
            ...(trim.startTicks === undefined
              ? {}
              : { startTicks: Math.round(trim.startTicks) }),
            ...(trim.endTicks === undefined
              ? {}
              : { endTicks: Math.round(trim.endTicks) }),
          });
        },
        updateClip: (clipId, update) => {
          assertOpen();
          const normalizedClipId = assertIdentifier(clipId, "Clip ID");
          if (typeof update !== "object" || update === null) {
            throw new InvalidExtensionTimelineCommandError(
              "updateClip requires an update object.",
            );
          }
          if (
            update.isMuted !== undefined &&
            typeof update.isMuted !== "boolean"
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "Clip isMuted must be a boolean when supplied.",
            );
          }
          if (update.isMuted === undefined) {
            throw new InvalidExtensionTimelineCommandError(
              "updateClip requires at least one property.",
            );
          }
          commands.push({
            kind: "update_clip",
            clipId: normalizedClipId,
            isMuted: update.isMuted,
          });
        },
        splitClip: (clipId, atTicks) => {
          assertOpen();
          const normalizedClipId = assertIdentifier(clipId, "Clip ID");
          assertFiniteTick(atTicks, "Split tick");
          commands.push({
            kind: "split_clip",
            clipId: normalizedClipId,
            atTicks: Math.round(atTicks),
          });
        },
        removeClip: (clipId) => {
          assertOpen();
          commands.push({
            kind: "remove_clip",
            clipId: assertIdentifier(clipId, "Clip ID"),
          });
        },
        createTrack: (input) => {
          assertOpen();
          if (input !== undefined && (typeof input !== "object" || input === null)) {
            throw new InvalidExtensionTimelineCommandError(
              "createTrack requires an input object when supplied.",
            );
          }
          if (
            input?.type !== undefined &&
            input.type !== "visual" &&
            input.type !== "audio"
          ) {
            throw new InvalidExtensionTimelineCommandError(
              'Track type must be "visual" or "audio" when supplied.',
            );
          }
          if (
            input?.index !== undefined &&
            (!Number.isInteger(input.index) || input.index < 0)
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "Track index must be a non-negative integer when supplied.",
            );
          }
          const trackId = `extension_track_${crypto.randomUUID()}`;
          commands.push({
            kind: "create_track",
            trackId,
            ...(input?.label === undefined
              ? {}
              : { label: assertIdentifier(input.label, "Track label") }),
            ...(input?.type === undefined ? {} : { type: input.type }),
            ...(input?.index === undefined ? {} : { index: input.index }),
          });
          return trackId;
        },
        updateTrack: (trackId, update) => {
          assertOpen();
          const normalizedTrackId = assertIdentifier(trackId, "Track ID");
          if (typeof update !== "object" || update === null) {
            throw new InvalidExtensionTimelineCommandError(
              "updateTrack requires an update object.",
            );
          }
          const flags = ["isVisible", "isMuted", "isLocked"] as const;
          for (const flag of flags) {
            if (update[flag] !== undefined && typeof update[flag] !== "boolean") {
              throw new InvalidExtensionTimelineCommandError(
                `Track ${flag} must be a boolean when supplied.`,
              );
            }
          }
          if (
            update.label === undefined &&
            flags.every((flag) => update[flag] === undefined)
          ) {
            throw new InvalidExtensionTimelineCommandError(
              "updateTrack requires at least one property.",
            );
          }
          commands.push({
            kind: "update_track",
            trackId: normalizedTrackId,
            ...(update.label === undefined
              ? {}
              : { label: assertIdentifier(update.label, "Track label") }),
            ...(update.isVisible === undefined
              ? {}
              : { isVisible: update.isVisible }),
            ...(update.isMuted === undefined ? {} : { isMuted: update.isMuted }),
            ...(update.isLocked === undefined
              ? {}
              : { isLocked: update.isLocked }),
          });
        },
        removeTrack: (trackId) => {
          assertOpen();
          commands.push({
            kind: "remove_track",
            trackId: assertIdentifier(trackId, "Track ID"),
          });
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
        createTransition: (input) => {
          assertOpen();
          if (typeof input !== "object" || input === null) {
            throw new InvalidExtensionTimelineCommandError(
              "createTransition requires an input object.",
            );
          }
          const localType = assertIdentifier(
            input.transitionType,
            "Transition type",
          );
          const definition = extensionTransitionRegistry.getDefinitionForOwner(
            scope.extension.id,
            localType,
          );
          if (!definition) {
            throw new InvalidExtensionTimelineCommandError(
              `Transition type '${localType}' is not registered by this extension.`,
              "transition_type_not_found",
            );
          }
          const parameters = {
            ...structuredClone(definition.parameters),
            ...(input.parameters
              ? cloneJsonObjectInput(input.parameters, "Transition parameters")
              : {}),
          };
          if (
            !definition.extension?.validateParameters(
              parameters,
              definition.schemaVersion ?? 1,
            )
          ) {
            throw new InvalidExtensionTimelineCommandError(
              `Transition type '${localType}' rejected the supplied parameters.`,
            );
          }
          const transition: Transition = {
            id: `transition_${crypto.randomUUID()}`,
            type: definition.type,
            outgoingClipId: assertIdentifier(
              input.outgoingClipId,
              "Outgoing clip ID",
            ),
            incomingClipId: assertIdentifier(
              input.incomingClipId,
              "Incoming clip ID",
            ),
            schemaVersion: definition.schemaVersion,
            parameters,
          };
          commands.push({ kind: "create_transition", transition });
          return transition.id;
        },
        updateTransitionParameters: (transitionId, parameters) => {
          assertOpen();
          const normalizedTransitionId = assertIdentifier(
            transitionId,
            "Transition ID",
          );
          const transition = getTimelineTransitions().find(
            (candidate) => candidate.id === normalizedTransitionId,
          );
          if (!transition) {
            throw new InvalidExtensionTimelineCommandError(
              `Transition '${normalizedTransitionId}' was not found.`,
              "transition_not_found",
            );
          }
          if (transitionOwnerId(transition.type) !== scope.extension.id) {
            throw new InvalidExtensionTimelineCommandError(
              `Extension '${scope.extension.id}' cannot mutate transition '${normalizedTransitionId}'.`,
              "wrong_owner",
            );
          }
          const definition = extensionTransitionRegistry.getDefinition(
            transition.type,
          );
          if (!definition) {
            throw new InvalidExtensionTimelineCommandError(
              `Transition type '${transition.type}' is not available.`,
              "transition_type_not_found",
            );
          }
          const updates = cloneJsonObjectInput(
            parameters,
            "Transition parameters",
          );
          const nextParameters = {
            ...transition.parameters,
            ...updates,
          };
          if (
            !definition.extension?.validateParameters(
              nextParameters,
              transition.schemaVersion ?? definition.schemaVersion ?? 1,
            )
          ) {
            throw new InvalidExtensionTimelineCommandError(
              `Transition type '${transition.type}' rejected the supplied parameters.`,
            );
          }
          commands.push({
            kind: "update_transition_parameters",
            transitionId: normalizedTransitionId,
            parameters: updates,
          });
        },
        removeTransition: (transitionId) => {
          assertOpen();
          const normalizedTransitionId = assertIdentifier(
            transitionId,
            "Transition ID",
          );
          const transition = getTimelineTransitions().find(
            (candidate) => candidate.id === normalizedTransitionId,
          );
          if (!transition) {
            throw new InvalidExtensionTimelineCommandError(
              `Transition '${normalizedTransitionId}' was not found.`,
              "transition_not_found",
            );
          }
          if (transitionOwnerId(transition.type) !== scope.extension.id) {
            throw new InvalidExtensionTimelineCommandError(
              `Extension '${scope.extension.id}' cannot remove transition '${normalizedTransitionId}'.`,
              "wrong_owner",
            );
          }
          commands.push({
            kind: "remove_transition",
            transitionId: normalizedTransitionId,
          });
        },
        addClipMask: (clipId, input) => {
          assertOpen();
          const normalizedClipId = assertIdentifier(clipId, "Clip ID");
          const generatedId = createExtensionMaskLocalId(
            scope.extension.id,
            crypto.randomUUID(),
          );
          const { mask, name } = cloneMaskInput(input, generatedId);
          commands.push({
            kind: "add_mask",
            clipId: normalizedClipId,
            mask,
            name,
          });
          return generatedId;
        },
        updateMaskParameters: (clipId, maskId, parameters) => {
          assertOpen();
          commands.push({
            kind: "update_mask_parameters",
            clipId: assertIdentifier(clipId, "Clip ID"),
            maskId: assertIdentifier(maskId, "Mask ID"),
            parameters: cloneMaskParameters(parameters),
          });
        },
        setMaskActiveRange: (clipId, maskId, range) => {
          assertOpen();
          commands.push({
            kind: "set_mask_active_range",
            clipId: assertIdentifier(clipId, "Clip ID"),
            maskId: assertIdentifier(maskId, "Mask ID"),
            range: range === null ? null : cloneMaskRange(range),
          });
        },
        removeMask: (clipId, maskId) => {
          assertOpen();
          commands.push({
            kind: "remove_mask",
            clipId: assertIdentifier(clipId, "Clip ID"),
            maskId: assertIdentifier(maskId, "Mask ID"),
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
            ? error.code
            : "callback_failed";
        return failedTransaction(normalizedLabel, code, error);
      } finally {
        isOpen = false;
      }

      return commitExtensionTimelineTransaction(
        normalizedLabel,
        scope.extension.id,
        commands,
        normalizedOptions,
      );
    },

    registerClipOverlay: (definition) => boundClipOverlays.register(definition),
    subscribe: bindOwnerScopedSubscribe(
      scope,
      timelineRevisionRelay,
      "Timeline",
    ),
    getRevision: () => timelineRevisionRelay.getRevision(),
  };
  return Object.freeze(api);
}
