import type {
  AssetFamily,
  AssetFamilyCompatibility,
  GeneratedCreationInput,
} from "../../../types/Asset";
import {
  areAssetFamilyCompatibilitiesEqual,
  isAssetFamilyCompatibilityComplete,
} from "../../../shared/utils/assetFamilies";
import {
  computeXxhash64Bytes,
  computeXxhash64String,
} from "../../../shared/utils/xxhash";
import { getAssetById } from "../../userAssets/api";
import type { SlotValue } from "../pipeline/types";
import type { WorkflowInput } from "../types";
import {
  buildRepeatableInputSlotId,
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
  getNodeInputRequestKeyForSlot,
  getWorkflowInputId,
  getWorkflowInputSlotValue,
  getWorkflowInputValue,
} from "./workflowInputs";
import { buildWorkflowStructureSignature } from "./workflowNodeSignature";

interface BuildGenerationFamilyRequestKeyOptions {
  workflow: Record<string, unknown> | null | undefined;
  workflowInputs: WorkflowInput[];
  slotValues: Record<string, SlotValue>;
  generationInputs: GeneratedCreationInput[];
}

const AUTO_FAMILY_REQUEST_KEY_PREFIX = "generation-family-request:v1:";
const AUTO_FAMILY_MATCH_KEY_PREFIX = "generation-family:v1:";

function stableSerialize(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    return `{${entries
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(String(value));
}

function buildGeneratedInputLookup(
  generationInputs: readonly GeneratedCreationInput[],
): Map<string, GeneratedCreationInput> {
  return new Map(
    generationInputs.map((generationInput) => [
      generationInput.inputId ?? generationInput.nodeId,
      generationInput,
    ]),
  );
}

async function buildExternalFileSignature(file: File): Promise<string> {
  return computeXxhash64Bytes(new Uint8Array(await file.arrayBuffer()));
}

async function buildMediaInputDescriptor(
  requestKey: string,
  slotValue: SlotValue | undefined,
  generationInput: GeneratedCreationInput | undefined,
): Promise<Record<string, unknown> | null> {
  if (!slotValue) {
    return null;
  }

  if (generationInput?.kind === "draggedAsset") {
    const asset = getAssetById(generationInput.parentAssetId);
    if (!asset) {
      return {
        key: requestKey,
        kind: "asset",
        parentAssetId: generationInput.parentAssetId,
      };
    }

    return {
      key: requestKey,
      kind: "asset",
      hash: asset.hash,
    };
  }

  if (generationInput?.kind === "timelineSelection") {
    return {
      key: requestKey,
      kind: "timelineSelection",
      selection: generationInput.timelineSelection,
    };
  }

  if (
    slotValue.type === "image" ||
    slotValue.type === "video" ||
    slotValue.type === "audio"
  ) {
    return {
      key: requestKey,
      kind: slotValue.type,
      hash: await buildExternalFileSignature(slotValue.file),
    };
  }

  if (slotValue.type === "video_selection") {
    return {
      key: requestKey,
      kind: "timelineSelection",
      selection: slotValue.selection,
    };
  }

  return null;
}

export async function buildGenerationFamilyRequestKey(
  options: BuildGenerationFamilyRequestKeyOptions,
): Promise<string | null> {
  const workflowStructure = buildWorkflowStructureSignature(options.workflow);
  if (!workflowStructure) {
    return null;
  }

  const workflowInputLookup = buildWorkflowInputLookup(options.workflowInputs);
  const generationInputLookup = buildGeneratedInputLookup(options.generationInputs);
  const textInputs: Array<{ key: string; value: string }> = [];
  const mediaInputs: Record<string, unknown>[] = [];

  const sortedInputs = [...options.workflowInputs].sort((left, right) =>
    getWorkflowInputId(left).localeCompare(getWorkflowInputId(right)),
  );

  for (const workflowInput of sortedInputs) {
    if (workflowInput.inputType === "text") {
      const slotValue = getWorkflowInputValue(
        options.slotValues,
        workflowInput,
        workflowInputLookup,
      );
      if (!slotValue || slotValue.type !== "text") {
        continue;
      }

      textInputs.push({
        key: getNodeInputRequestKey(workflowInput, workflowInputLookup),
        value: slotValue.value,
      });
      continue;
    }

    const repeatableMax = workflowInput.presentation?.repeatable?.max ?? 1;
    for (let index = 0; index < repeatableMax; index += 1) {
      const inputId = buildRepeatableInputSlotId(workflowInput, index);
      const slotValue = getWorkflowInputSlotValue(
        options.slotValues,
        workflowInput,
        index,
        workflowInputLookup,
      );
      const mediaDescriptor = await buildMediaInputDescriptor(
        getNodeInputRequestKeyForSlot(
          inputId,
          workflowInput,
          workflowInputLookup,
        ),
        slotValue,
        generationInputLookup.get(inputId) ??
          generationInputLookup.get(workflowInput.nodeId),
      );
      if (mediaDescriptor) {
        mediaInputs.push(mediaDescriptor);
      }
    }
  }

  const signaturePayload = stableSerialize({
    workflowStructure,
    textInputs,
    mediaInputs,
  });

  return `${AUTO_FAMILY_REQUEST_KEY_PREFIX}${await computeXxhash64String(
    signaturePayload,
  )}`;
}

export async function buildGenerationFamilyAutoMatchKey(
  requestKey: string | null | undefined,
  compatibility: AssetFamilyCompatibility | null | undefined,
): Promise<string | null> {
  if (!requestKey || !isAssetFamilyCompatibilityComplete(compatibility)) {
    return null;
  }

  return `${AUTO_FAMILY_MATCH_KEY_PREFIX}${await computeXxhash64String(
    stableSerialize({
      requestKey,
      compatibility,
    }),
  )}`;
}

export function resolveFamilyForGenerationMatchKey(
  families: readonly AssetFamily[],
  matchKey: string | null | undefined,
  compatibility: AssetFamilyCompatibility | null | undefined,
  now = Date.now(),
): AssetFamily | undefined {
  if (!matchKey || !isAssetFamilyCompatibilityComplete(compatibility)) {
    return undefined;
  }

  const matchingFamily = families.find(
    (family) =>
      family.autoMatchKeys?.includes(matchKey) &&
      areAssetFamilyCompatibilitiesEqual(family.compatibility, compatibility),
  );

  if (!matchingFamily) {
    return {
      id: crypto.randomUUID(),
      autoMatchKeys: [matchKey],
      compatibility,
      createdAt: now,
      updatedAt: now,
    };
  }

  const autoMatchKeys = new Set(matchingFamily.autoMatchKeys ?? []);
  autoMatchKeys.add(matchKey);

  return {
    ...matchingFamily,
    autoMatchKeys: [...autoMatchKeys].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}
