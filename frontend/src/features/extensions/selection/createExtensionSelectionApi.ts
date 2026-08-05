import { createRevisionRelay } from "../../../core/shell/revisionRelay";
import {
  getExtensionTimelineSelection,
  getTimelineStoreForTrustedHostAccess,
  setExtensionTimelineClipSelection,
  setExtensionTimelineTransitionSelection,
} from "../../timeline/api";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import type { ExtensionApiScope, ExtensionSelectionApi } from "../types";

/**
 * Selection lives in the timeline store but is deliberately absent from the
 * timeline relay, whose contract is commit-grained model changes. Selecting a
 * clip is an interaction, not a commit, so it gets its own signal here rather
 * than waking every timeline subscriber.
 *
 * Watched by value, not by array identity: `selectClip(null)` installs a fresh
 * empty array even when the selection was already empty, so identity watching
 * would notify on clicks that changed nothing. Order is part of the value
 * because the snapshot reports host selection order.
 *
 * `JSON.stringify` rather than a delimiter join: no separator can collide with
 * an ID, so `["a", "b"]` and `["a b"]` stay distinguishable.
 */
const selectionRelay = createRevisionRelay(
  getTimelineStoreForTrustedHostAccess(),
  (state) => [
    JSON.stringify(state.selectedClipIds),
    state.selectedTransitionId,
  ],
);

export function createExtensionSelectionApi(
  scope: ExtensionApiScope,
): ExtensionSelectionApi {
  return Object.freeze({
    get: () => getExtensionTimelineSelection(),
    // Malformed input throws (the caller's bug); unknown IDs come back as a
    // typed refusal (the editor's answer). Validation itself lives beside the
    // model in features/timeline, next to the state it checks.
    setClips: (clipIds: readonly string[]) => {
      if (!Array.isArray(clipIds)) {
        throw new TypeError("Clip selection must be an array of clip IDs.");
      }
      for (const clipId of clipIds) {
        if (typeof clipId !== "string" || clipId.length === 0) {
          throw new TypeError("Clip selection IDs must be non-empty strings.");
        }
      }
      return setExtensionTimelineClipSelection(clipIds);
    },
    setTransition: (transitionId: string | null) => {
      if (
        transitionId !== null &&
        (typeof transitionId !== "string" || transitionId.length === 0)
      ) {
        throw new TypeError(
          "Transition selection must be a non-empty string or null.",
        );
      }
      return setExtensionTimelineTransitionSelection(transitionId);
    },
    subscribe: bindOwnerScopedSubscribe(scope, selectionRelay, "Selection"),
    getRevision: () => selectionRelay.getRevision(),
  });
}
