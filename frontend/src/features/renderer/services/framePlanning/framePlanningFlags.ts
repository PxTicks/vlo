/**
 * Rollout flag for the live frame-planning graph.
 *
 * Defaults on (the graph drives live preview). A dev rollback path can force
 * the legacy per-engine render path without a rebuild via
 * `localStorage["vlo.liveFrameGraph"] = "off"` (then reload). Tests flip it
 * through `setLiveFrameGraphEnabled`.
 *
 * The flag is read once at Player mount, so changes require a reload — it is a
 * rollout/rollback switch, not a live toggle. Export is unconditional and does
 * not consult this flag.
 */
const STORAGE_KEY = "vlo.liveFrameGraph";

function readOverride(): boolean | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (value === "off" || value === "false") return false;
    if (value === "on" || value === "true") return true;
  } catch {
    // localStorage may be unavailable (workers, tests, privacy mode).
  }
  return null;
}

let enabled = readOverride() ?? true;

export function isLiveFrameGraphEnabled(): boolean {
  return enabled;
}

export function setLiveFrameGraphEnabled(next: boolean): void {
  enabled = next;
}
