import { useState, useEffect, useCallback, useRef } from "react";
import { useTransformationViewStore } from "../store/useTransformationViewStore";
import { isSplineParameter } from "../types";
import type { SplineParameter } from "../types";

interface SplineContext {
  clipId: string;
  transformId: string;
  property: string;
}

interface UseSplinePopoverOptions {
  value: unknown;
  onCommit: (val: unknown) => void;
  minTime: number;
  duration: number;
  defaultValue?: unknown;
  context?: SplineContext;
}

export function useSplinePopover({
  value,
  onCommit,
  minTime,
  duration,
  defaultValue,
  context,
}: UseSplinePopoverOptions) {
  const setActiveSpline = useTransformationViewStore(
    (state) => state.setActiveSpline,
  );

  const isSpline = isSplineParameter(value);
  const numericValue = isSpline
    ? (value.points[0]?.value ?? 0)
    : (value as number);

  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const open = Boolean(anchorEl);

  // Store the value snapshot when the editor opens, for cancel
  const snapshotRef = useRef<unknown>(null);

  // Sync active spline when context becomes available (e.g. after creating transform)
  useEffect(() => {
    if (open && context) {
      setActiveSpline(context);
    }
  }, [open, context, setActiveSpline]);

  const handleOpenGraph = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // Snapshot current value before any edits
      snapshotRef.current = isSpline
        ? { type: "spline", points: [...(value as SplineParameter).points] }
        : value;

      if (!isSpline) {
        const newSpline = {
          type: "spline",
          points: [
            { time: minTime, value: numericValue },
            { time: minTime + duration, value: numericValue },
          ],
        };
        onCommit(newSpline);
        // Snapshot the newly created spline so cancel reverts to scalar
        snapshotRef.current = value; // the original scalar
      }
      setAnchorEl(event.currentTarget);
      if (context) setActiveSpline(context);
    },
    [isSpline, value, onCommit, minTime, duration, numericValue, context, setActiveSpline],
  );

  const handleAccept = useCallback(() => {
    // Keep the current value as-is and close
    setAnchorEl(null);
    if (context) setActiveSpline(null);
  }, [context, setActiveSpline]);

  const handleCancel = useCallback(() => {
    // Revert to the snapshot taken when the editor was opened
    if (snapshotRef.current !== null) {
      onCommit(snapshotRef.current);
    }
    setAnchorEl(null);
    if (context) setActiveSpline(null);
  }, [onCommit, context, setActiveSpline]);

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
    onCommit(flatSpline);
  }, [defaultValue, numericValue, minTime, duration, onCommit]);

  return {
    isSpline,
    numericValue,
    anchorEl,
    open,
    handleOpenGraph,
    handleAccept,
    handleCancel,
    handleClear,
  };
}
