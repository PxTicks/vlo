import type { Asset } from "../../../types/Asset";
import type { CompositeContent } from "../../../types/TimelineTypes";
import {
  getProjectDimensions,
  renderSelectionToVideoFile,
  type ExportConfig,
  type ProjectData,
  type SelectionRenderInputs,
} from "../../renderer";
import { mediaSecondsToTick } from "../../renderer/utils/mediaTime";
import {
  compositeContentToSelection,
  hashCompositeContent,
} from "../../timelineSelection";
import { useProjectStore } from "../../project/useProjectStore";
import { getAssets, addLocalAsset } from "../../userAssets";
import { getTimelineTracks } from "../../timeline/api";

export interface BakeCompositeOptions {
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
  compositeAssetId?: string;
  compositeClipId?: string;
  allowDuplicateHash?: boolean;
}

export interface BakedComposite {
  /** The registered baked video asset. */
  asset: Asset;
  /** Duration of the registered bake in timeline ticks when available. */
  bakedDurationTicks: number | null;
  /** Hash of the content this bake was rendered from (for staleness checks). */
  contentHash: string;
}

function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function durationSecondsToTicks(
  durationSeconds: number | null | undefined,
): number | null {
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }

  return Math.max(0, mediaSecondsToTick(durationSeconds, "floor"));
}

/**
 * Builds the in-memory export inputs for a composite's content (the analog of
 * generation's `buildSyntheticRenderInputs`): a project-sized export config and
 * a project assembled from the content's own tracks/clips.
 */
function buildCompositeRenderInputs(
  content: CompositeContent,
): SelectionRenderInputs {
  const project = useProjectStore.getState();
  const dimensions = getProjectDimensions(project.config.aspectRatio);
  const exportConfig: ExportConfig = {
    logicalWidth: dimensions.width,
    logicalHeight: dimensions.height,
    outputWidth: toEven(dimensions.width),
    outputHeight: toEven(dimensions.height),
    backgroundAlpha: 0,
  };

  const fps =
    typeof content.fps === "number" && content.fps > 0
      ? content.fps
      : Math.max(1, project.config.fps);

  const projectData: ProjectData = {
    tracks: content.tracks ?? getTimelineTracks(),
    clips: content.clips,
    assets: getAssets(),
    duration: content.durationTicks,
    fps,
  };

  return { exportConfig, projectData };
}

/**
 * Renders composite content to a hidden video asset. Timeline placements point
 * directly at that baked asset, so playback/export use the normal video path.
 */
export async function bakeComposite(
  content: CompositeContent,
  options: BakeCompositeOptions = {},
): Promise<BakedComposite> {
  const selection = compositeContentToSelection(content);
  const contentHash = hashCompositeContent(content);

  const file = await renderSelectionToVideoFile(selection, {
    renderInputs: buildCompositeRenderInputs(content),
    signal: options.signal,
    onProgress: options.onProgress,
    filenamePrefix: "composite",
  });

  const asset = await addLocalAsset(
    file,
    {
      source: "composite",
      ...(options.compositeAssetId
        ? { compositeAssetId: options.compositeAssetId }
        : {}),
      ...(options.compositeClipId
        ? { compositeClipId: options.compositeClipId }
        : {}),
      timelineSelection: selection,
      contentHash,
    },
    undefined,
    {
      // Baked composites are clip-private working assets. Identical bytes should
      // still produce separate assets so copied composites can be edited alone.
      allowDuplicateHash: options.allowDuplicateHash ?? true,
    },
  );
  if (!asset) {
    throw new Error("Failed to register baked composite asset");
  }

  return {
    asset,
    bakedDurationTicks: durationSecondsToTicks(asset.duration),
    contentHash,
  };
}
