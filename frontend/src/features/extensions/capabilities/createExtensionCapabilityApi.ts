import { createElement, type ReactNode } from "react";
import { createRevisionRelay } from "../../../core/shell/revisionRelay";
import {
  blockingCheck,
  useRuntimeCapabilityStore,
  type CapabilityOperationOutcome,
} from "../../runtimeCapabilities";
import type { RuntimeCapability } from "../../../types/RuntimeStatus";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import { ExtensionCapabilityNotice } from "./ExtensionCapabilityNotice";
import type {
  ExtensionApiScope,
  ExtensionCapabilityApi,
  ExtensionCapabilityNoticeProps,
  ExtensionCapabilityOperationResult,
  ExtensionCapabilitySnapshot,
  ExtensionCapabilityView,
} from "../types";

/**
 * Separates the owning extension from the capability it registered. Must match
 * `NAMESPACE_SEPARATOR` in `backend/services/extensions/capabilities.py`, which
 * is where ids are actually minted.
 */
const NAMESPACE_SEPARATOR = ":";

/** Mirrors `_LOCAL_ID` in the backend registrar, so a bad name fails here too. */
const LOCAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Any reported change: a capability replaced by a read, the read status, or a
 * recheck/test starting or finishing. Not scoped to the owner's own ids — host
 * capabilities are readable, so a listener that gates a feature on SAM2 has to
 * hear about SAM2.
 */
const capabilitySignal = createRevisionRelay(useRuntimeCapabilityStore, (state) => [
  state.capabilities,
  state.status,
  state.refreshing,
  state.testing,
]);

/**
 * One of the caller's own capabilities, whichever way they addressed it.
 *
 * A bare name is always the caller's own — never a host capability that
 * happens to share it. Resolving bare names against the host set instead would
 * mean a host capability added in a later release silently retargeted an
 * extension's existing id, and would make an extension's own `"sam2"`
 * unreachable by the local name the backend registrar explicitly allows it to
 * register. Host capabilities have their own accessors.
 */
function resolveOwn(ownerId: string, capabilityId: unknown): string {
  const requested = requireId(capabilityId);

  if (requested.includes(NAMESPACE_SEPARATOR)) {
    const parts = requested.split(NAMESPACE_SEPARATOR);
    const owner = parts.slice(0, -1).join(NAMESPACE_SEPARATOR);
    const local = parts[parts.length - 1] ?? "";
    if (owner !== ownerId || !LOCAL_ID.test(local)) {
      throw new TypeError(
        `Capability '${requested}' does not belong to '${ownerId}'. An ` +
          "extension can read its own capabilities and the host's, not another " +
          "extension's.",
      );
    }
    return requested;
  }

  if (!LOCAL_ID.test(requested)) {
    throw new TypeError(
      `'${requested}' is not a usable capability name: use lowercase letters, ` +
        "digits and hyphens, matching the descriptor you registered.",
    );
  }
  return `${ownerId}${NAMESPACE_SEPARATOR}${requested}`;
}

/**
 * A host capability id. Host ids carry no namespace, so a namespaced one here
 * is an extension's — the caller's own or a neighbour's — and is refused
 * rather than quietly read.
 */
function resolveHost(capabilityId: unknown): string {
  const requested = requireId(capabilityId);
  if (requested.includes(NAMESPACE_SEPARATOR)) {
    throw new TypeError(
      `'${requested}' is an extension capability, not a host one: read your ` +
        "own with get() or read().",
    );
  }
  return requested;
}

function requireId(capabilityId: unknown): string {
  if (typeof capabilityId !== "string" || capabilityId.trim() === "") {
    throw new TypeError("Capability id must be a non-empty string.");
  }
  return capabilityId.trim();
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}

/**
 * A capability detached from the store that holds it.
 *
 * Cloned, not merely frozen at the top level: the checks, the device, the
 * model rows and the last failure are live objects inside the host's own
 * state, and handing those out would let an extension edit what the Runtime
 * Diagnostics panel reports — with no store update, so the editor would never
 * even re-render to reveal it. Capability payloads are small and read far more
 * often than they change, so the clone is not worth optimising away.
 */
function toSnapshot(capability: RuntimeCapability): ExtensionCapabilitySnapshot {
  return deepFreeze(structuredClone(capability)) as ExtensionCapabilitySnapshot;
}

function viewOf(capabilityId: string): ExtensionCapabilityView {
  const state = useRuntimeCapabilityStore.getState();
  const capability = state.capabilities[capabilityId] ?? null;
  const snapshot = capability === null ? null : toSnapshot(capability);
  // Derived from the detached copy, so the check an extension is holding is
  // one it cannot use to reach back into the store.
  const failure = blockingCheck(snapshot as RuntimeCapability | null);
  return deepFreeze({
    id: capabilityId,
    capability: snapshot,
    checking:
      capability === null && (state.status === "idle" || state.status === "checking"),
    // Unknown is not available: until something is known, nothing is offered.
    canAttempt: capability?.canAttempt ?? false,
    verifiedThrough: capability?.verifiedThrough ?? null,
    failure,
    failureCode: failure?.code ?? null,
    message: failure?.summary ?? (capability === null ? state.error : null),
    rechecking: state.refreshing.includes(capabilityId),
    testing: state.testing.includes(capabilityId),
  }) as ExtensionCapabilityView;
}

function resultOf(
  capabilityId: string,
  outcome: CapabilityOperationOutcome,
): ExtensionCapabilityOperationResult {
  const view = viewOf(capabilityId);
  if (outcome.status === "succeeded") {
    return Object.freeze({ ok: true as const, view });
  }
  return Object.freeze({
    ok: false as const,
    status: outcome.status,
    error: outcome.error,
    view,
  });
}

/**
 * Owner-bound `api.capabilities` (backend-extension-contract plan, Phase D):
 * the frontend half of a capability an extension's backend registered.
 *
 * This is a projection over the host's own single-flight capability store, not
 * a second client for `/app/runtime-capabilities`. That is the whole point:
 * an extension panel and the Runtime Diagnostics panel read the same answer,
 * serialise their rechecks against each other, and cannot end up disagreeing
 * about whether a runtime is available.
 */
export function createExtensionCapabilityApi(
  scope: ExtensionApiScope,
): ExtensionCapabilityApi {
  const ownerId = scope.extension.id;
  const prefix = `${ownerId}${NAMESPACE_SEPARATOR}`;

  function assertActive(action: string): void {
    if (scope.signal.aborted) {
      throw new Error(
        `Extension '${ownerId}' cannot ${action} a capability after deactivation.`,
      );
    }
  }

  /**
   * Load tests this owner is still following.
   *
   * A test polls for up to twenty minutes. Without this, an extension the user
   * disabled would keep a poll loop alive against a capability that no longer
   * exists. One scope-owned resource covers every test the extension starts —
   * the store's own `cancelTests` is all-or-nothing and would have taken the
   * host's tests down with it.
   */
  const followedTests = new Set<string>();
  scope.own({
    dispose: () => {
      const store = useRuntimeCapabilityStore.getState();
      for (const capabilityId of followedTests) store.cancelTest(capabilityId);
      followedTests.clear();
    },
  });

  async function whileFollowed<TResult>(
    capabilityId: string,
    work: Promise<TResult>,
  ): Promise<TResult> {
    followedTests.add(capabilityId);
    try {
      return await work;
    } finally {
      followedTests.delete(capabilityId);
    }
  }

  const FailureNotice = (props: ExtensionCapabilityNoticeProps) =>
    createElement(ExtensionCapabilityNotice, {
      capabilityId: props?.host
        ? resolveHost(props.capabilityId)
        : resolveOwn(ownerId, props?.capabilityId),
      fallbackMessage: props.fallbackMessage ?? null,
      dense: props.dense ?? false,
      // The SDK types a download surface as `unknown`: it is arbitrary trusted
      // React, and the contract does not name React types.
      downloadSurface: props.downloadSurface as ReactNode,
    });

  return Object.freeze({
    list: () =>
      Object.freeze(
        Object.values(useRuntimeCapabilityStore.getState().capabilities)
          .filter((capability) => capability.id.startsWith(prefix))
          .map(toSnapshot),
      ),

    get: (capabilityId: string) => snapshotOf(resolveOwn(ownerId, capabilityId)),
    read: (capabilityId: string) => viewOf(resolveOwn(ownerId, capabilityId)),

    getHost: (capabilityId: string) => snapshotOf(resolveHost(capabilityId)),
    readHost: (capabilityId: string) => viewOf(resolveHost(capabilityId)),

    getStatus: () => useRuntimeCapabilityStore.getState().status,

    ensureLoaded: () => useRuntimeCapabilityStore.getState().ensureLoaded(),

    subscribe: bindOwnerScopedSubscribe(scope, capabilitySignal, "Capability"),
    getRevision: () => capabilitySignal.getRevision(),

    recheck: async (capabilityId: string) => {
      const id = resolveOwn(ownerId, capabilityId);
      assertActive("recheck");
      const outcome = await useRuntimeCapabilityStore
        .getState()
        .refreshCapability(id);
      return resultOf(id, outcome);
    },

    test: async (capabilityId: string) => {
      const id = resolveOwn(ownerId, capabilityId);
      assertActive("test");
      const outcome = await whileFollowed(
        id,
        useRuntimeCapabilityStore.getState().testCapability(id),
      );
      return resultOf(id, outcome);
    },

    FailureNotice,
  });
}

function snapshotOf(capabilityId: string): ExtensionCapabilitySnapshot | null {
  const capability =
    useRuntimeCapabilityStore.getState().capabilities[capabilityId] ?? null;
  return capability === null ? null : toSnapshot(capability);
}
