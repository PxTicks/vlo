/**
 * Allowlist of workflow IDs that have been migrated to use the frontend
 * pre-resolve path (graphToPrompt-based rewriting).
 *
 * Only workflows in this list will use the new path when the feature flag
 * `preResolvedPromptEnabled` is turned on. Un-migrated workflows always
 * fall through to the existing backend rewrite path.
 */
export const MIGRATED_WORKFLOW_IDS: ReadonlySet<string> = new Set([
  "video_ltx2_3_i2v_t2v_basic.json",
]);
