import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTransformationViewStore } from "../store/useTransformationViewStore";
import { useSplineEditSessionStore } from "../store/useSplineEditSessionStore";
import { isSplineParameter } from "../types";
import type { SplineParameter } from "../types";

interface SplineContext {
  contextId: string;
  transformId?: string;
  property: string;
}

interface UseSplinePopoverOptions {
  value: unknown;
  onCommit: (val: unknown) => void;
  minTime: number;
  duration: number;
  defaultValue?: unknown;
  context?: SplineContext;
  captureSnapshot?: () => unknown | null;
  restoreSnapshot?: (snapshot: unknown) => void;
}

export function useSplinePopover({
  value,
  onCommit,
  minTime,
  duration,
  defaultValue,
  context,
  captureSnapshot,
  restoreSnapshot,
}: UseSplinePopoverOptions) {
  const setActiveSpline = useTransformationViewStore(
    (state) => state.setActiveSpline,
  );
  const activeSession = useSplineEditSessionStore((state) => state.activeSession);
  const beginSession = useSplineEditSessionStore((state) => state.beginSession);
  const recordValue = useSplineEditSessionStore((state) => state.recordValue);
  const acceptSession = useSplineEditSessionStore((state) => state.acceptSession);
  const cancelSession = useSplineEditSessionStore((state) => state.cancelSession);
  const clearSession = useSplineEditSessionStore((state) => state.clearSession);

  const sessionIdRef = useRef<string | null>(null);
  const sessionValue =
    sessionIdRef.current !== null && activeSession?.id === sessionIdRef.current
      ? activeSession.history[activeSession.historyIndex]
      : undefined;
  const effectiveValue = sessionValue ?? value;

  const isSpline = isSplineParameter(effectiveValue);
  const numericValue = isSpline
    ? (effectiveValue.points[0]?.value ?? 0)
    : (effectiveValue as number);

  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const open = Boolean(anchorEl);

  const editorValue = useMemo(() => {
    if (isSplineParameter(sessionValue)) {
      return sessionValue;
    }

    if (isSplineParameter(value)) {
      return value;
    }

    return null;
  }, [sessionValue, value]);

  // Sync active spline when context becomes available (e.g. after creating transform)
  useEffect(() => {
    if (open && context?.transformId) {
      setActiveSpline({
        clipId: context.contextId,
        transformId: context.transformId,
        property: context.property,
      });
    }
  }, [open, context, setActiveSpline]);

  useEffect(
    () => () => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        clearSession(sessionId);
      }
    },
    [clearSession],
  );

  const commitSessionValue = useCallback(
    (nextValue: unknown) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        recordValue(sessionId, nextValue);
      }
      onCommit(nextValue);
    },
    [onCommit, recordValue],
  );

  const handleOpenGraph = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const sessionId = crypto.randomUUID();
      const originalTargetSnapshot = captureSnapshot?.();
      const initialSplineValue: SplineParameter = isSplineParameter(value)
        ? {
            type: "spline",
            points: [...value.points],
          }
        : {
            type: "spline",
            points: [
              { time: minTime, value: numericValue },
              { time: minTime + duration, value: numericValue },
            ],
          };

      beginSession({
        id: sessionId,
        originalTargetSnapshot,
        initialValue: initialSplineValue,
      });
      sessionIdRef.current = sessionId;

      if (!isSplineParameter(value)) {
        onCommit(initialSplineValue);
      }

      setAnchorEl(event.currentTarget);
      if (context?.transformId) {
        setActiveSpline({
          clipId: context.contextId,
          transformId: context.transformId,
          property: context.property,
        });
      }
    },
    [
      beginSession,
      captureSnapshot,
      context,
      duration,
      minTime,
      numericValue,
      onCommit,
      setActiveSpline,
      value,
    ],
  );

  const handleAccept = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      acceptSession(sessionId);
      sessionIdRef.current = null;
    }
    setAnchorEl(null);
    setActiveSpline(null);
  }, [acceptSession, setActiveSpline]);

  const handleCancel = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      const session = cancelSession(sessionId);
      if (session) {
        restoreSnapshot?.(session.originalTargetSnapshot);
      }
      sessionIdRef.current = null;
    }

    setAnchorEl(null);
    setActiveSpline(null);
  }, [cancelSession, restoreSnapshot, setActiveSpline]);

  const handleClear = useCallback(() => {
    // Flatten the spline to a constant default value
    const flatValue = typeof defaultValue === "number" ? defaultValue : numericValue;
    const flatSpline: SplineParameter = {
      type: "spline",
      points: [
        { time: minTime, value: flatValue },
        { time: minTime + duration, value: flatValue },
      ],
    };
    commitSessionValue(flatSpline);
  }, [commitSessionValue, defaultValue, duration, minTime, numericValue]);

  return {
    isSpline: editorValue !== null,
    numericValue,
    anchorEl,
    open,
    editorValue,
    commitSessionValue,
    handleOpenGraph,
    handleAccept,
    handleCancel,
    handleClear,
  };
}
