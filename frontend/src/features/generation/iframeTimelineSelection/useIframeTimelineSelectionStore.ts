import { create } from "zustand";
import type {
  GeneratedCreationInput,
  GeneratedCreationMetadata,
} from "../../../types/Asset";
import { projectTemporaryFileService } from "../../project/services/ProjectTemporaryFileService";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import type {
  IframeTemporaryAsset,
  ProcessedIframeTimelineSelection,
  StoredIframeTimelineSelection,
} from "./types";

interface IframeTimelineSelectionNodeBinding {
  nodeId: string;
  temporaryAssetId: string;
}

interface IframeTimelineSelectionState {
  assets: IframeTemporaryAsset[];
  nodeBindings: IframeTimelineSelectionNodeBinding[];
  storeProcessedSelection: (
    result: ProcessedIframeTimelineSelection,
  ) => Promise<StoredIframeTimelineSelection>;
  bindNodeToAsset: (nodeId: string, assetId: string) => void;
  clearRuntime: () => void;
}

function revokeUrl(value: string | undefined): void {
  if (value?.startsWith("blob:")) {
    URL.revokeObjectURL(value);
  }
}

function clearAssetUrls(assets: readonly IframeTemporaryAsset[]): void {
  for (const entry of assets) {
    revokeUrl(entry.asset.src);
    revokeUrl(entry.asset.thumbnail);
  }
}

function createTemporaryAsset(
  id: string,
  role: "video" | "mask",
  file: File,
  sourcePath: string,
  thumbnail: File,
  timelineSelection: ProcessedIframeTimelineSelection["timelineSelection"],
  processing: Pick<
    ProcessedIframeTimelineSelection,
    "maskCropMetadata" | "aspectRatioProcessing"
  >,
): IframeTemporaryAsset {
  const durationTicks = Math.max(
    0,
    (timelineSelection.end ?? timelineSelection.start) - timelineSelection.start,
  );
  return {
    role,
    selectionId: id,
    timelineSelection: structuredClone(timelineSelection),
    maskCropMetadata: structuredClone(processing.maskCropMetadata),
    aspectRatioProcessing: processing.aspectRatioProcessing
      ? structuredClone(processing.aspectRatioProcessing)
      : null,
    asset: {
      id: `iframe-selection-${id}-${role}`,
      hash: `temporary-${id}-${role}`,
      name: role === "video" ? `Timeline selection ${id}.mp4` : `Timeline selection mask ${id}.mp4`,
      type: "video",
      src: URL.createObjectURL(file),
      sourcePath,
      thumbnail: URL.createObjectURL(thumbnail),
      file,
      duration: tickToMediaSeconds(durationTicks),
      fps: timelineSelection.fps,
      createdAt: Date.now(),
      creationMetadata: {
        source: "extracted",
        timelineSelection: structuredClone(timelineSelection),
      },
    },
  };
}

export const useIframeTimelineSelectionStore =
  create<IframeTimelineSelectionState>((set, get) => ({
    assets: [],
    nodeBindings: [],

    storeProcessedSelection: async (result) => {
      const selectionId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const videoPath = await projectTemporaryFileService.writeIframeSelectionFile(
        selectionId,
        "video",
        result.video,
      );
      await projectTemporaryFileService.writeIframeSelectionFile(
        selectionId,
        "thumbnail",
        result.thumbnail,
      );
      const videoAsset = createTemporaryAsset(
        selectionId,
        "video",
        result.video,
        videoPath,
        result.thumbnail,
        result.timelineSelection,
        result,
      );

      let maskAsset: IframeTemporaryAsset | null = null;
      if (result.mask) {
        const maskPath =
          await projectTemporaryFileService.writeIframeSelectionFile(
            selectionId,
            "mask",
            result.mask,
          );
        maskAsset = createTemporaryAsset(
          selectionId,
          "mask",
          result.mask,
          maskPath,
          result.thumbnail,
          result.timelineSelection,
          result,
        );
      }

      set((state) => ({
        assets: [videoAsset, ...(maskAsset ? [maskAsset] : []), ...state.assets],
      }));
      return { selectionId, videoAsset, maskAsset };
    },

    bindNodeToAsset: (nodeId, assetId) => {
      const isTemporaryAsset = get().assets.some(
        (entry) => entry.asset.id === assetId,
      );
      set((state) => ({
        nodeBindings: [
          ...state.nodeBindings.filter((binding) => binding.nodeId !== nodeId),
          ...(isTemporaryAsset
            ? [{ nodeId, temporaryAssetId: assetId }]
            : []),
        ],
      }));
    },

    clearRuntime: () =>
      set((state) => {
        clearAssetUrls(state.assets);
        return { assets: [], nodeBindings: [] };
      }),
  }));

projectTemporaryFileService.onClear(() => {
  useIframeTimelineSelectionStore.getState().clearRuntime();
});

export function getIframeTimelineSelectionCreationInputs(): GeneratedCreationInput[] {
  const { assets, nodeBindings } = useIframeTimelineSelectionStore.getState();
  const assetById = new Map(assets.map((entry) => [entry.asset.id, entry]));

  return nodeBindings.flatMap((binding) => {
    const entry = assetById.get(binding.temporaryAssetId);
    if (!entry) return [];
    return [
      {
        nodeId: binding.nodeId,
        kind: "timelineSelection" as const,
        timelineSelection: structuredClone(entry.timelineSelection),
      },
    ];
  });
}

export function getIframeTimelineSelectionGenerationMetadata(): Pick<
  GeneratedCreationMetadata,
  "inputs" | "maskCropMetadata" | "targetResolution"
> {
  const state = useIframeTimelineSelectionStore.getState();
  const boundAssetIds = new Set(
    state.nodeBindings.map((binding) => binding.temporaryAssetId),
  );
  const primaryEntry =
    state.assets.find(
      (entry) => entry.role === "video" && boundAssetIds.has(entry.asset.id),
    ) ?? state.assets.find((entry) => boundAssetIds.has(entry.asset.id));

  return {
    inputs: getIframeTimelineSelectionCreationInputs(),
    ...(primaryEntry
      ? { maskCropMetadata: structuredClone(primaryEntry.maskCropMetadata) }
      : {}),
    ...(primaryEntry?.aspectRatioProcessing
      ? {
          targetResolution:
            primaryEntry.aspectRatioProcessing.requested.resolution,
        }
      : {}),
  };
}
