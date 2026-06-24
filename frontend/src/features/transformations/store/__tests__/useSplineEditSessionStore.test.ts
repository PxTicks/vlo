import { beforeEach, describe, expect, it } from "vitest";
import { useSplineEditSessionStore } from "../useSplineEditSessionStore";

describe("useSplineEditSessionStore", () => {
  beforeEach(() => {
    useSplineEditSessionStore.setState({ activeSession: null });
  });

  it("tracks draft history for the active session", () => {
    const store = useSplineEditSessionStore.getState();

    store.beginSession({
      id: "session-1",
      originalTargetSnapshot: { clipId: "clip-1" },
      initialValue: { type: "spline", points: [{ time: 0, value: 1 }] },
    });
    store.recordValue("session-1", {
      type: "spline",
      points: [{ time: 0, value: 2 }],
    });
    store.recordValue("session-1", {
      type: "spline",
      points: [{ time: 0, value: 3 }],
    });

    const activeSession = useSplineEditSessionStore.getState().activeSession;
    expect(activeSession?.history).toHaveLength(3);
    expect(activeSession?.historyIndex).toBe(2);
  });

  it("returns the original snapshot on cancel and clears the session", () => {
    const store = useSplineEditSessionStore.getState();
    const originalTargetSnapshot = {
      kind: "clip",
      clipId: "clip-1",
      transforms: [],
    };

    store.beginSession({
      id: "session-2",
      originalTargetSnapshot,
      initialValue: { type: "spline", points: [{ time: 0, value: 1 }] },
    });

    const cancelled = store.cancelSession("session-2");

    expect(cancelled?.originalTargetSnapshot).toEqual(originalTargetSnapshot);
    expect(useSplineEditSessionStore.getState().activeSession).toBeNull();
  });

  it("accepts matching sessions and returns an isolated snapshot", () => {
    const store = useSplineEditSessionStore.getState();
    store.beginSession({
      id: "session-3",
      originalTargetSnapshot: { nested: { value: 1 } },
      initialValue: { value: 1 },
    });
    const accepted = store.acceptSession("session-3");
    expect(accepted).toMatchObject({
      id: "session-3",
      historyIndex: 0,
    });
    expect(useSplineEditSessionStore.getState().activeSession).toBeNull();
    (accepted?.originalTargetSnapshot as { nested: { value: number } }).nested
      .value = 9;
    expect(accepted?.history).toEqual([{ value: 1 }]);
  });

  it("ignores mismatched mutations and clear requests", () => {
    const store = useSplineEditSessionStore.getState();
    expect(store.acceptSession("missing")).toBeNull();
    expect(store.cancelSession("missing")).toBeNull();
    store.clearSession();

    store.beginSession({
      id: "session-4",
      originalTargetSnapshot: {},
      initialValue: { value: 1 },
    });
    store.recordValue("other", { value: 2 });
    store.clearSession("other");
    expect(useSplineEditSessionStore.getState().activeSession?.history).toEqual([
      { value: 1 },
    ]);
    store.clearSession("session-4");
    expect(useSplineEditSessionStore.getState().activeSession).toBeNull();
  });

  it("truncates redo history before recording a replacement value", () => {
    const store = useSplineEditSessionStore.getState();
    store.beginSession({
      id: "session-5",
      originalTargetSnapshot: {},
      initialValue: 1,
    });
    store.recordValue("session-5", 2);
    useSplineEditSessionStore.setState((state) => ({
      activeSession: state.activeSession
        ? { ...state.activeSession, historyIndex: 0 }
        : null,
    }));
    store.recordValue("session-5", 3);
    expect(useSplineEditSessionStore.getState().activeSession).toMatchObject({
      history: [1, 3],
      historyIndex: 1,
    });
  });
});
