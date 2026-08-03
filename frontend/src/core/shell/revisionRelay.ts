/**
 * Commit-grained change signal derived from a store (extension-shell-surfaces
 * plan §7). A relay watches selected state parts by identity and bumps one
 * monotonic revision when any part is replaced — so selection-only or
 * interaction-only store updates that keep model references stable do not
 * signal. Feature-free shell machinery; owner-scoped listener isolation is
 * the adapter layer's job.
 */

export interface RevisionSource {
  subscribe(listener: () => void): () => void;
  getRevision(): number;
}

interface RelayStore<TState> {
  getState(): TState;
  subscribe(listener: () => void): () => void;
}

export function createRevisionRelay<TState>(
  store: RelayStore<TState>,
  selectParts: (state: TState) => readonly unknown[],
): RevisionSource {
  let revision = 0;
  let lastParts = selectParts(store.getState());
  const listeners = new Set<() => void>();
  let unsubscribeStore: (() => void) | null = null;

  const check = (): boolean => {
    const parts = selectParts(store.getState());
    const changed =
      parts.length !== lastParts.length ||
      parts.some((part, index) => !Object.is(part, lastParts[index]));
    if (changed) {
      lastParts = parts;
      revision += 1;
    }
    return changed;
  };

  const onStoreChange = () => {
    if (!check()) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Relay observers are derived notifications; isolation with
        // diagnostics belongs to the owner-scoped adapter wrapping them.
      }
    }
  };

  return Object.freeze({
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (unsubscribeStore === null) {
        // Catch up before attaching so pre-subscription changes are not
        // replayed as a spurious first notification.
        check();
        unsubscribeStore = store.subscribe(onStoreChange);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribeStore !== null) {
          unsubscribeStore();
          unsubscribeStore = null;
        }
      };
    },
    getRevision: () => {
      check();
      return revision;
    },
  });
}

/**
 * One revision source over several relays, for a read API whose snapshot is
 * assembled from more than one store. The combined revision is the sum of the
 * member revisions: monotonic because each member is, and it changes whenever
 * any member does. Members keep their own lazy store subscriptions, so a
 * combined source that nobody subscribes to attaches nothing.
 */
export function combineRevisionSources(
  ...sources: readonly RevisionSource[]
): RevisionSource {
  if (sources.length === 0) {
    throw new RangeError("A combined revision source needs at least one member.");
  }
  if (sources.length === 1) return sources[0];

  return Object.freeze({
    subscribe: (listener: () => void) => {
      const unsubscribes = sources.map((source) => source.subscribe(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    getRevision: () =>
      sources.reduce((total, source) => total + source.getRevision(), 0),
  });
}
