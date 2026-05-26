import type { Asset } from "../../../types/Asset";
import type { CompositeContent } from "../../../types/TimelineTypes";
import {
  getProjectDimensions,
  renderSelectionToVideoFile,
  type ExportConfig,
  type ProjectData,
  type SelectionRenderInputs,
} from "../../renderer";
import {
  compositeContentToSelection,
  hashCompositeContent,
} from "../../timelineSelection";
import { useProjectStore } from "../../project/useProjectStore";
import { getAssets, addLocalAsset } from "../../userAssets";
import { useTimelineStore } from "../../timeline/useTimelineStore";

export interface BakeCompositeProxyOptions {
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
  compositeClipId?: string;
  allowDuplicateHash?: boolean;
}

export interface BakedCompositeProxy {
  /** The registered proxy video asset. */
  asset: Asset;
  /** Hash of the content this proxy was baked from (for staleness checks). */
  contentHash: string;
}

function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
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
    tracks: content.tracks ?? useTimelineStore.getState().tracks,
    clips: content.clips,
    assets: getAssets(),
    duration: content.durationTicks,
    fps,
  };

  return { exportConfig, projectData };
}

/**
 * Renders a Composite clip's content to an mp4 and registers it as a video
 * asset — the "prebaked proxy". The clip then renders through the normal video
 * path by pointing its `proxyAssetId` at the returned asset.
 *
 * The render itself reuses {@link renderSelectionToVideoFile}: the content is
 * replayed as a zero-anchored TimelineSelection against composite-specific
 * in-memory render inputs.
 */
export async function bakeCompositeProxy(
  content: CompositeContent,
  options: BakeCompositeProxyOptions = {},
): Promise<BakedCompositeProxy> {
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
      ...(options.compositeClipId
        ? { compositeClipId: options.compositeClipId }
        : {}),
      timelineSelection: selection,
      contentHash,
    },
    undefined,
    {
      // Composite proxies are clip-private working assets. Identical bytes should
      // still produce separate assets so copied composites can be edited alone.
      allowDuplicateHash: options.allowDuplicateHash ?? true,
    },
  );
  if (!asset) {
    throw new Error("Failed to register composite proxy asset");
  }

  return { asset, contentHash };
}
