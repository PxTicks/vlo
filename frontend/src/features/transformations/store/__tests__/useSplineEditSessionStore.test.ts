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
});
