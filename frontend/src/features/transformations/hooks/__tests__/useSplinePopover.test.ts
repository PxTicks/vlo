import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSplinePopover } from "../useSplinePopover";
import { useSplineEditSessionStore } from "../../store/useSplineEditSessionStore";
import { useTransformationViewStore } from "../../store/useTransformationViewStore";

describe("useSplinePopover", () => {
  beforeEach(() => {
    useSplineEditSessionStore.setState({ activeSession: null });
    useTransformationViewStore.setState({ activeSpline: null });
  });

  it("restores the captured target snapshot on cancel after opening from a scalar value", () => {
    const onCommit = vi.fn();
    const captureSnapshot = vi.fn(() => ({ kind: "clip", clipId: "clip-1" }));
    const restoreSnapshot = vi.fn();
    const anchor = document.createElement("button");

    const { result } = renderHook(() =>
      useSplinePopover({
        value: 1,
        onCommit,
        minTime: 0,
        duration: 10,
        defaultValue: 1,
        context: {
          contextId: "clip-1",
          property: "factor",
        },
        captureSnapshot,
        restoreSnapshot,
      }),
    );

    act(() => {
      result.current.handleOpenGraph({
        currentTarget: anchor,
      } as React.MouseEvent<HTMLButtonElement>);
    });

    expect(onCommit).toHaveBeenCalledWith({
      type: "spline",
      points: [
        { time: 0, value: 1 },
        { time: 10, value: 1 },
      ],
    });

    act(() => {
      result.current.handleCancel();
    });

    expect(restoreSnapshot).toHaveBeenCalledWith({
      kind: "clip",
      clipId: "clip-1",
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(useSplineEditSessionStore.getState().activeSession).toBeNull();
  });

  it("records in-session spline edits and restores the original snapshot on cancel", () => {
    const onCommit = vi.fn();
    const restoreSnapshot = vi.fn();
    const anchor = document.createElement("button");
    const splineValue = {
      type: "spline" as const,
      points: [
        { time: 0, value: 1 },
        { time: 10, value: 1 },
      ],
    };

    const { result } = renderHook(() =>
      useSplinePopover({
        value: splineValue,
        onCommit,
        minTime: 0,
        duration: 10,
        defaultValue: 1,
        context: {
          contextId: "clip-1",
          transformId: "transform-1",
          property: "x",
        },
        captureSnapshot: () => ({
          kind: "clip",
          clipId: "clip-1",
          transforms: [{ id: "transform-1" }],
        }),
        restoreSnapshot,
      }),
    );

    act(() => {
      result.current.handleOpenGraph({
        currentTarget: anchor,
      } as React.MouseEvent<HTMLButtonElement>);
    });

    act(() => {
      result.current.commitSessionValue({
        type: "spline",
        points: [
          { time: 0, value: 1 },
          { time: 5, value: 2 },
          { time: 10, value: 1 },
        ],
      });
    });

    expect(useSplineEditSessionStore.getState().activeSession?.history).toHaveLength(2);
    expect(onCommit).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.handleCancel();
    });

    expect(restoreSnapshot).toHaveBeenCalledWith({
      kind: "clip",
      clipId: "clip-1",
      transforms: [{ id: "transform-1" }],
    });
  });
});
