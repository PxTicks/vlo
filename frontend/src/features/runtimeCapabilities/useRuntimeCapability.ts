import { useCallback, useEffect } from "react";
import type {
  CapabilityCheck,
  CapabilityFailureCode,
  RuntimeCapability,
} from "../../types/RuntimeStatus";
import { blockingCheck } from "./failureCodes";
import { useRuntimeCapabilityStore } from "./useRuntimeCapabilityStore";

export interface RuntimeCapabilityView {
  capability: RuntimeCapability | null;
  /** True while the first answer is still being fetched. */
  checking: boolean;
  /** The only gate a feature surface should use to enable its action. */
  canAttempt: boolean;
  /** The check that explains why not, when something is known to be failing. */
  failure: CapabilityCheck | null;
  failureCode: CapabilityFailureCode | null;
  /** A message for surfaces with one line to spend. */
  message: string | null;
  refreshing: boolean;
  recheck: () => void;
}

/**
 * One capability, loaded on demand.
 *
 * Replaces the per-feature availability probes: both used to call a different
 * endpoint, interpret it differently, and disagree about what "ready" meant.
 */
export function useRuntimeCapability(
  capabilityId: string,
  options: { enabled?: boolean } = {},
): RuntimeCapabilityView {
  const enabled = options.enabled ?? true;
  const capability = useRuntimeCapabilityStore(
    (state) => state.capabilities[capabilityId] ?? null,
  );
  const status = useRuntimeCapabilityStore((state) => state.status);
  const storeError = useRuntimeCapabilityStore((state) => state.error);
  const refreshing = useRuntimeCapabilityStore((state) =>
    state.refreshing.includes(capabilityId),
  );
  const ensureLoaded = useRuntimeCapabilityStore((state) => state.ensureLoaded);
  const refreshCapability = useRuntimeCapabilityStore(
    (state) => state.refreshCapability,
  );

  // Fetch-from-effect is the documented escape hatch when no data-fetching
  // library is in play; the store dedupes concurrent callers, so several
  // surfaces mounting at once still make one request.
  useEffect(() => {
    if (!enabled) return;
    void ensureLoaded();
  }, [enabled, ensureLoaded]);

  const recheck = useCallback(() => {
    void refreshCapability(capabilityId);
  }, [capabilityId, refreshCapability]);

  const failure = blockingCheck(capability);
  const checking =
    capability === null && (status === "idle" || status === "checking");

  return {
    capability,
    checking,
    // Unknown is not available: until something is known, nothing is offered.
    canAttempt: capability?.canAttempt ?? false,
    failure,
    failureCode: failure?.code ?? null,
    message: failure?.summary ?? (capability === null ? storeError : null),
    refreshing,
    recheck,
  };
}
