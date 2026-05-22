import { create } from "zustand";

interface SplineEditSession {
  id: string;
  originalTargetSnapshot: unknown;
  history: unknown[];
  historyIndex: number;
}

interface BeginSplineEditSessionInput {
  id: string;
  originalTargetSnapshot: unknown;
  initialValue: unknown;
}

interface SplineEditSessionState {
  activeSession: SplineEditSession | null;
  beginSession: (input: BeginSplineEditSessionInput) => void;
  recordValue: (sessionId: string, nextValue: unknown) => void;
  acceptSession: (sessionId: string) => SplineEditSession | null;
  cancelSession: (sessionId: string) => SplineEditSession | null;
  clearSession: (sessionId?: string) => void;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export const useSplineEditSessionStore = create<SplineEditSessionState>(
  (set, get) => ({
    activeSession: null,

    beginSession: ({ id, originalTargetSnapshot, initialValue }) => {
      set({
        activeSession: {
          id,
          originalTargetSnapshot: cloneValue(originalTargetSnapshot),
          history: [cloneValue(initialValue)],
          historyIndex: 0,
        },
      });
    },

    recordValue: (sessionId, nextValue) => {
      const activeSession = get().activeSession;
      if (!activeSession || activeSession.id !== sessionId) {
        return;
      }

      const nextHistory = activeSession.history
        .slice(0, activeSession.historyIndex + 1)
        .concat(cloneValue(nextValue));

      set({
        activeSession: {
          ...activeSession,
          history: nextHistory,
          historyIndex: nextHistory.length - 1,
        },
      });
    },

    acceptSession: (sessionId) => {
      const activeSession = get().activeSession;
      if (!activeSession || activeSession.id !== sessionId) {
        return null;
      }

      set({ activeSession: null });
      return cloneValue(activeSession);
    },

    cancelSession: (sessionId) => {
      const activeSession = get().activeSession;
      if (!activeSession || activeSession.id !== sessionId) {
        return null;
      }

      set({ activeSession: null });
      return cloneValue(activeSession);
    },

    clearSession: (sessionId) => {
      const activeSession = get().activeSession;
      if (!activeSession) {
        return;
      }

      if (sessionId && activeSession.id !== sessionId) {
        return;
      }

      set({ activeSession: null });
    },
  }),
);
