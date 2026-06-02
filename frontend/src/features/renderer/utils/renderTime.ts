/**
 * Back-compat shim. The clip-local decode-time helpers now live in the
 * `mediaTime` boundary module; re-exported here so existing importers keep
 * working. Prefer importing from `mediaTime` (or the renderer public API) for
 * new code. The broad importer migration is tracked as a later phase.
 */
export { calculatePlayerFrameTime, snapFrameTimeSeconds } from "./mediaTime";
