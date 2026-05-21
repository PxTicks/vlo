import type { Asset } from "../../../types/Asset";
import type { CompositeContent } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import {
  beginCompositeRender,
  endCompositeRender,
} from "../useCompositeRenderStatusStore";
import { bakeCompositeProxy } from "./bakeCompositeProxy";

export async function renderCompositeProxyForClip(
  clipId: string,
  contentOverride?: CompositeContent,
): Promise<Asset | null> {
  const clip = useTimelineStore
    .getState()
    .clips.find((candidate) => candidate.id === clipId);
  const content = contentOverride ?? (clip?.type === "composite" ? clip.content : null);
  if (!clip || clip.type !== "composite" || !content) {
    return null;
  }

  beginCompositeRender(clipId);
  try {
    const { asset, contentHash } = await bakeCompositeProxy(content, {
      compositeClipId: clipId,
    });
    useTimelineStore.getState().setCompositeProxy(clipId, asset.id, contentHash);
    return asset;
  } finally {
    endCompositeRender(clipId);
  }
}

export function scheduleCompositeProxyRender(
  clipId: string,
  contentOverride?: CompositeContent,
): void {
  void renderCompositeProxyForClip(clipId, contentOverride).catch((error) => {
    console.error(`Failed to render composite proxy for '${clipId}'`, error);
    endCompositeRender(clipId);
  });
}
