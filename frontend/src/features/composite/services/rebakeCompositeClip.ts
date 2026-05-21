import type { Asset } from "../../../types/Asset";
import type { CompositeContent } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../../timeline";
import {
  bakeCompositeProxy,
  type BakeCompositeProxyOptions,
} from "./bakeCompositeProxy";

/**
 * Re-bakes a composite clip's current content and swaps in the fresh proxy.
 * The live bridge: after the clip's `content` changes, this regenerates the
 * baked video so the timeline reflects the edit. No-op for non-composites.
 */
export async function rebakeCompositeClip(
  clipId: string,
  options: BakeCompositeProxyOptions = {},
): Promise<Asset | null> {
  const clip = useTimelineStore
    .getState()
    .clips.find((candidate) => candidate.id === clipId);
  if (!clip || clip.type !== "composite") {
    return null;
  }

  const { asset, contentHash } = await bakeCompositeProxy(clip.content, options);
  useTimelineStore.getState().setCompositeProxy(clipId, asset.id, contentHash);
  return asset;
}

/**
 * Applies an edit to a composite clip's internal content and re-bakes its
 * proxy in one step — the entry point a nested composite editor calls on save.
 */
export async function applyCompositeContentEdit(
  clipId: string,
  content: CompositeContent,
  options: BakeCompositeProxyOptions = {},
): Promise<Asset | null> {
  useTimelineStore.getState().setCompositeContent(clipId, content);
  return rebakeCompositeClip(clipId, options);
}
