import type { Asset } from "../../../types/Asset";
import type {
  CompositeContent,
  TimelineSelection,
} from "../../../types/TimelineTypes";
// Renderer entry points are imported dynamically (see `bakeComposite`) so that
// `composite` does not statically depend on the renderer feature. Composite
// baking is a downward call into rendering, but a static edge here would close
// the renderer <-> feature-UI import cycle. Types are erased and stay static.
import type {
  ExportConfig,
  ProjectData,
  RenderedFramePixelCapture,
  SelectionRenderInputs,
} from "../../renderer";
import {
  compositeContentToSelection,
  hashCompositeContent,
} from "../../timelineSelection";
import {
  COMPOSITE_BAKE_KEY_FRAME_INTERVAL_SECONDS,
  COMPOSITE_RENDER_FRAME_STEP,
  createCompositeBakeKey,
  serializeCompositeBakeKey,
} from "../utils/compositeRenderContract";
import { useProjectStore } from "../../project/useProjectStore";
import { getAssets, addLocalAsset } from "../../userAssets";
import { getTimelineTracks } from "../../timeline/api";

export interface BakeCompositeOptions {
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
  compositeAssetId?: string;
  compositeClipId?: string;
  compositeRevision?: number;
  allowDuplicateHash?: boolean;
  /** Phase-0 parity seam: captures the project composite before encoding. */
  onBeforeEncodeFrame?: (
    frame: RenderedFramePixelCapture,
  ) => void | Promise<void>;
}

export interface BakedComposite {
  /** The registered baked video asset. */
  asset: Asset;
  /** Hash of the content this bake was rendered from (for staleness checks). */
  contentHash: string;
  /** Complete serialized render-contract identity for this cache asset. */
  bakeKey: string;
}

export interface RenderCompositeFileOptions {
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
  onBeforeEncodeFrame?: (
    frame: RenderedFramePixelCapture,
  ) => void | Promise<void>;
  /**
   * Optional local-timeline range. The production bake omits this and renders
   * the complete content; headed diagnostics use a one-frame range without
   * registering a working asset.
   */
  selection?: TimelineSelection;
}

export interface RenderedCompositeFile {
  file: File;
  contentHash: string;
  bakeKey: string;
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
  getProjectDimensions: typeof import("../../renderer/utils/dimensions")["getProjectDimensions"],
  assets: readonly Asset[],
  rasterDimensions: { width: number; height: number },
): SelectionRenderInputs {
  const project = useProjectStore.getState();
  const dimensions = getProjectDimensions(project.config.aspectRatio);
  const exportConfig: ExportConfig = {
    logicalWidth: dimensions.width,
    logicalHeight: dimensions.height,
    outputWidth: toEven(rasterDimensions.width),
    outputHeight: toEven(rasterDimensions.height),
    backgroundAlpha: 0,
  };

  const fps =
    typeof content.fps === "number" && content.fps > 0
      ? content.fps
      : Math.max(1, project.config.fps);

  const projectData: ProjectData = {
    tracks: content.tracks ?? getTimelineTracks(),
    clips: content.clips,
    transitions: content.transitions,
    composites: [],
    assets: [...assets],
    duration: content.durationTicks,
    fps,
  };

  return { exportConfig, projectData };
}

/**
 * Renders composite content to an in-memory alpha-preserving WebM without
 * registering it as a project asset. Production baking registers the result;
 * strict E2E diagnostics can inspect a bounded render without leaving a cache.
 */
export async function renderCompositeToVideoFile(
  content: CompositeContent,
  options: RenderCompositeFileOptions = {},
): Promise<RenderedCompositeFile> {
  const selection = options.selection ?? compositeContentToSelection(content);
  // frameStep is workflow sampling guidance, not a playback-cache cadence.
  // Composite bakes contain every frame at the resolved FPS so direct and
  // baked playback share the same frame-edge contract.
  const renderSelection = {
    ...selection,
    frameStep: COMPOSITE_RENDER_FRAME_STEP,
  };
  const contentHash = hashCompositeContent(content);

  // Dynamic import keeps `composite` off the static renderer import graph.
  const [
    { renderSelectionToVideoFile },
    { getProjectDimensions },
    { resolveCompositeRasterDimensionsForContent },
  ] =
    await Promise.all([
      import("../../renderer/services/renderSelectionToVideoFile"),
      import("../../renderer/utils/dimensions"),
      import("../../renderer/utils/compositeRasterDimensions"),
    ]);

  // Use one asset snapshot for both dependency identity and rendering so the
  // published key describes the exact dependency set supplied to the renderer.
  const assets = getAssets();
  const project = useProjectStore.getState();
  const logicalDimensions = getProjectDimensions(project.config.aspectRatio);
  const rasterDimensions = await resolveCompositeRasterDimensionsForContent(
    content,
    assets,
    logicalDimensions,
  );
  const bakeKey = serializeCompositeBakeKey(
    createCompositeBakeKey({
      content,
      projectFps: project.config.fps,
      logicalDimensions,
      assets,
    }),
  );

  const file = await renderSelectionToVideoFile(renderSelection, {
    renderInputs: buildCompositeRenderInputs(
      content,
      getProjectDimensions,
      assets,
      rasterDimensions,
    ),
    signal: options.signal,
    onProgress: options.onProgress,
    filenamePrefix: "composite",
    format: "webm",
    keyFrameInterval: COMPOSITE_BAKE_KEY_FRAME_INTERVAL_SECONDS,
    preserveAlpha: true,
    ...(options.onBeforeEncodeFrame
      ? { onBeforeEncodeFrame: options.onBeforeEncodeFrame }
      : {}),
  });

  return { file, contentHash, bakeKey };
}

export async function bakeComposite(
  content: CompositeContent,
  options: BakeCompositeOptions = {},
): Promise<BakedComposite> {
  const selection = compositeContentToSelection(content);
  const { file, contentHash, bakeKey } = await renderCompositeToVideoFile(
    content,
    {
      selection,
      signal: options.signal,
      onProgress: options.onProgress,
      ...(options.onBeforeEncodeFrame
        ? { onBeforeEncodeFrame: options.onBeforeEncodeFrame }
        : {}),
    },
  );

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
      bakeKey,
      ...(options.compositeRevision != null
        ? { compositeRevision: options.compositeRevision }
        : {}),
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
    contentHash,
    bakeKey,
  };
}
