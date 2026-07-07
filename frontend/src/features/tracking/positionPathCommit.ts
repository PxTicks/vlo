import type {
  ExtensionTimelineApi,
  ExtensionTimelineTransactionResult,
  JsonValue,
} from "../extensions/types";
import type { PositionPathParameter } from "../transformations/types";

export interface CommitTrackingPositionPathOptions {
  timeline: Pick<ExtensionTimelineApi, "listClips" | "transaction">;
  clipId: string;
  path: PositionPathParameter;
  label?: string;
}

export type CommitTrackingPositionPathResult =
  | {
      ok: true;
      transformId: string;
      transaction: Extract<ExtensionTimelineTransactionResult, { ok: true }>;
    }
  | {
      ok: false;
      message: string;
      transaction?: ExtensionTimelineTransactionResult;
    };

function toJsonValue(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

export function commitTrackingPositionPath(
  options: CommitTrackingPositionPathOptions,
): CommitTrackingPositionPathResult {
  const clip = options.timeline
    .listClips()
    .find((candidate) => candidate.id === options.clipId);
  if (!clip) {
    return {
      ok: false,
      message: `Timeline clip '${options.clipId}' was not found.`,
    };
  }

  const existingPosition = clip.transformations.find(
    (transform) => transform.type === "position",
  );
  const parameters: Record<string, JsonValue> = {
    ...(existingPosition
      ? structuredClone(existingPosition.parameters)
      : { x: 0, y: 0 }),
    path: toJsonValue(options.path),
  };
  delete parameters.extensionPath;
  if (!("x" in parameters)) parameters.x = 0;
  if (!("y" in parameters)) parameters.y = 0;

  let transformId = existingPosition?.id ?? `tracking_position_${crypto.randomUUID()}`;
  const transaction = options.timeline.transaction(
    options.label ?? "Create path from mask",
    (draft) => {
      transformId = draft.upsertTransform(options.clipId, {
        id: transformId,
        type: "position",
        isEnabled: existingPosition?.isEnabled ?? true,
        parameters,
        ...(existingPosition?.keyframeTimes
          ? { keyframeTimes: existingPosition.keyframeTimes }
          : {}),
        ...(existingPosition?.templateId
          ? { templateId: existingPosition.templateId }
          : {}),
      });
    },
  );

  if (!transaction.ok) {
    return {
      ok: false,
      message: transaction.message,
      transaction,
    };
  }

  return { ok: true, transformId, transaction };
}
