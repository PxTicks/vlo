import type { CompositeContent } from "../../../types/TimelineTypes";
import { isCompositeClip } from "../../../types/TimelineTypes";

/**
 * True when a composite's content contains a placement of another composite.
 * Nesting is disallowed: it would require keeping a parent composite's stored
 * content in sync with a child's re-bakes/deletes, which the asset-backed model
 * deliberately doesn't track. Blocking it here keeps every baked composite a
 * flat, self-contained render.
 */
export function contentContainsComposite(content: CompositeContent): boolean {
  return content.clips.some((clip) => isCompositeClip(clip));
}
