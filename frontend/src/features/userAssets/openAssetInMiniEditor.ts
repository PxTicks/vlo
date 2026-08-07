import type { Asset } from "../../types/Asset";
import { useMiniEditorStore } from "../miniEditor";
import { mediaSecondsToTick } from "../renderer/utils/mediaTime";
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
}

/** Opens any library-compatible asset through the shared mini editor. */
export async function openAssetInMiniEditor(
  asset: Asset,
  options: OpenAssetInMiniEditorOptions,
): Promise<void> {
  const isTemporal = asset.type === "video" || asset.type === "audio";

  await useMiniEditorStore.getState().open({
    openerId: options.openerId,
    autoPlay: asset.type === "video",
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
        sourceUrl: URL.createObjectURL(file),
        sourceFile: file,
        durationTicks: mediaSecondsToTick(durationSeconds),
        mediaType: asset.type,
      };
    },
    onExtractRange: isTemporal
      ? async (spec, source) => {
          const file = await extractAssetRangeFile(
            source,
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
            const file = await extractAssetFrameFile(source, playheadTicks);
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
  });
}
