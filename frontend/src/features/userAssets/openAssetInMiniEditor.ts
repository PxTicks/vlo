import type { Asset } from "../../types/Asset";
import type { WorkspaceActivationResult } from "../../core/shell/workspaces";
import {
  openMiniEditorWorkspace,
  useMiniEditorStore,
  type MiniEditorOpenArgs,
  type MiniEditorPresentation,
} from "../miniEditor";
import { mediaSecondsToTick } from "../../core/time";
import {
  extractAssetFrameFile,
  extractAssetRangeFile,
} from "./services/AssetExtractionService";
import { mediaProcessingService } from "./services/MediaProcessingService";
import { useAssetStore } from "./useAssetStore";

interface AssetMiniEditorNavigation {
  onPrevious?: () => void;
  onNext?: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
}

interface OpenAssetInMiniEditorOptions {
  openerId: string;
  onClose?: () => void;
  navigation?: AssetMiniEditorNavigation;
  /** The asset browser is the workspace canary; other callers retain the modal. */
  presentation?: MiniEditorPresentation;
}

/** Opens any library-compatible asset through the shared mini editor. */
export async function openAssetInMiniEditor(
  asset: Asset,
  options: OpenAssetInMiniEditorOptions,
): Promise<WorkspaceActivationResult> {
  const isTemporal = asset.type === "video" || asset.type === "audio";

  const args: MiniEditorOpenArgs = {
    openerId: options.openerId,
    autoPlay: asset.type === "video",
    presentation: options.presentation ?? "modal",
    title: asset.name,
    prepare: async () => {
      const hydrated = await useAssetStore
        .getState()
        .ensureAssetSourceLoaded(asset.id);
      const file = hydrated?.file ?? asset.file;
      if (!file) {
        throw new Error(`Could not load ${asset.name}.`);
      }

      const durationSeconds = isTemporal
        ? (hydrated?.duration ??
          asset.duration ??
          (await mediaProcessingService.computeDuration(file)))
        : 0;

      return {
        assetId: asset.id,
        sourceUrl: URL.createObjectURL(file),
        sourceFile: file,
        durationTicks: mediaSecondsToTick(durationSeconds),
        mediaType: asset.type,
      };
    },
    onExtractRange: isTemporal
      ? async (spec, source) => {
          const file = await extractAssetRangeFile(
            {
              sourceFile: source.sourceFile,
              mediaType: source.mediaType === "audio" ? "audio" : "video",
            },
            spec.cropStartTicks,
            spec.cropEndTicks,
          );
          await useAssetStore.getState().addLocalAsset(file, {
            source: "asset_excerpt",
            parentAssetId: asset.id,
            kind: "range",
            startTicks: spec.cropStartTicks,
            endTicks: spec.cropEndTicks,
          });
          return "Range extracted to the asset library.";
        }
      : undefined,
    onExtractFrame:
      asset.type === "video"
        ? async (playheadTicks, source) => {
            const file = await extractAssetFrameFile(
              {
                sourceUrl: source.sourceUrl,
                sourceFilename: source.sourceFile.name,
              },
              playheadTicks,
            );
            await useAssetStore.getState().addLocalAsset(file, {
              source: "asset_excerpt",
              parentAssetId: asset.id,
              kind: "frame",
              startTicks: playheadTicks,
              endTicks: playheadTicks,
            });
            return "Frame extracted to the asset library.";
          }
        : undefined,
    onClose: options.onClose,
    onPrevious: options.navigation?.onPrevious,
    onNext: options.navigation?.onNext,
    hasPrevious: options.navigation?.hasPrevious,
    hasNext: options.navigation?.hasNext,
    frameConstraint:
      asset.type === "video" && asset.fps && asset.fps > 0
        ? { fps: asset.fps, frameStep: 1 }
        : undefined,
  };

  if (options.presentation === "workspace") {
    return openMiniEditorWorkspace({
      assetId: asset.id,
      title: asset.name,
      args,
    });
  }
  await useMiniEditorStore.getState().open(args);
  return { status: "opened" };
}
