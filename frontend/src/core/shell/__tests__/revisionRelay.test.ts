import { describe, expect, it, vi } from "vitest";
import { createRevisionRelay } from "../revisionRelay";

interface FakeState {
  model: readonly string[];
  selection: readonly string[];
}

function createFakeStore(initial: FakeState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState: (next: Partial<FakeState>) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe("createRevisionRelay", () => {
  it("bumps the revision only when watched parts change identity", () => {
    const store = createFakeStore({ model: ["a"], selection: [] });
    const relay = createRevisionRelay(store, (state) => [state.model]);
    const listener = vi.fn();
    relay.subscribe(listener);
    const initial = relay.getRevision();

    // Unwatched (selection-style) updates keep the same model reference.
    store.setState({ selection: ["a"] });
    expect(listener).not.toHaveBeenCalled();
    expect(relay.getRevision()).toBe(initial);

    store.setState({ model: ["a", "b"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(relay.getRevision()).toBe(initial + 1);
  });

  it("tracks revisions without listeners and does not replay missed changes on subscribe", () => {
    const store = createFakeStore({ model: ["a"], selection: [] });
    const relay = createRevisionRelay(store, (state) => [state.model]);
    const before = relay.getRevision();

    store.setState({ model: ["b"] });
    expect(relay.getRevision()).toBe(before + 1);

    const listener = vi.fn();
    relay.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("detaches from the store when the last listener unsubscribes", () => {
    const store = createFakeStore({ model: [], selection: [] });
    const relay = createRevisionRelay(store, (state) => [state.model]);
    const unsubscribeA = relay.subscribe(vi.fn());
    const unsubscribeB = relay.subscribe(vi.fn());
    expect(store.listenerCount()).toBe(1);
    unsubscribeA();
    expect(store.listenerCount()).toBe(1);
    unsubscribeB();
    expect(store.listenerCount()).toBe(0);
  });

  it("isolates throwing listeners from other listeners", () => {
    const store = createFakeStore({ model: [], selection: [] });
    const relay = createRevisionRelay(store, (state) => [state.model]);
    const healthy = vi.fn();
    relay.subscribe(() => {
      throw new Error("boom");
    });
    relay.subscribe(healthy);
    store.setState({ model: ["a"] });
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
