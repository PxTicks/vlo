import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { SplineGraph } from "../SplineEditor";
import type { SplineParameter } from "../../types";

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0);
}

function TestHarness() {
  const [value, setValue] = useState<SplineParameter>({
    type: "spline",
    points: [
      { time: 0, value: 1 },
      { time: 5, value: 1 },
      { time: 10, value: 1 },
    ],
  });

  return (
    <>
      <SplineGraph
        value={value}
        onChange={setValue}
        width={400}
        height={250}
        minTime={0}
        duration={10}
        minY={0}
        maxY={2}
      />
      <output data-testid="points-json">{JSON.stringify(value.points)}</output>
    </>
  );
}

function TrimmedDomainHarness() {
  const [value, setValue] = useState<SplineParameter>({
    type: "spline",
    points: [
      { time: 5, value: 1 },
      { time: 10, value: 1 },
      { time: 15, value: 1 },
    ],
  });

  return (
    <>
      <SplineGraph
        value={value}
        onChange={setValue}
        width={400}
        height={250}
        minTime={5}
        duration={10}
        minY={0}
        maxY={2}
      />
      <output data-testid="trimmed-points-json">
        {JSON.stringify(value.points)}
      </output>
    </>
  );
}

describe("SplineGraph", () => {
  beforeAll(() => {
    if (!globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame = (handle: number) => {
        window.clearTimeout(handle);
      };
    }
  });

  it("keeps a newly added point after dragging an existing point", async () => {
    const { container } = render(<TestHarness />);
    const svg = container.querySelector("svg");
    if (!svg) {
      throw new Error("Expected spline svg");
    }

    const circles = container.querySelectorAll("circle");
    const middlePoint = circles[1];
    if (!middlePoint) {
      throw new Error("Expected middle spline point");
    }

    await act(async () => {
      fireEvent.mouseDown(middlePoint, {
        button: 0,
        clientX: 200,
        clientY: 125,
      });
      fireEvent.mouseMove(window, {
        clientX: 240,
        clientY: 80,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      fireEvent.mouseUp(window, {
        clientX: 240,
        clientY: 80,
      });
    });

    await act(async () => {
      fireEvent.mouseDown(svg, {
        button: 0,
        clientX: 300,
        clientY: 100,
      });
      fireEvent.mouseUp(window, {
        clientX: 300,
        clientY: 100,
      });
    });

    await waitFor(() => {
      const points = JSON.parse(
        screen.getByTestId("points-json").textContent ?? "[]",
      ) as Array<{ time: number; value: number }>;
      expect(points).toHaveLength(4);
      expect(
        points.some(
          (point) => Math.abs(point.time - 7.631578947368421) < 0.01,
        ),
      ).toBe(true);
    });
  });

  it("preserves non-zero time domains when adding a point after drag", async () => {
    const { container } = render(<TrimmedDomainHarness />);
    const svg = container.querySelector("svg");
    if (!svg) {
      throw new Error("Expected spline svg");
    }

    const circles = container.querySelectorAll("circle");
    const middlePoint = circles[1];
    if (!middlePoint) {
      throw new Error("Expected middle spline point");
    }

    await act(async () => {
      fireEvent.mouseDown(middlePoint, {
        button: 0,
        clientX: 200,
        clientY: 125,
      });
      fireEvent.mouseMove(window, {
        clientX: 240,
        clientY: 80,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      fireEvent.mouseUp(window, {
        clientX: 240,
        clientY: 80,
      });
    });

    await act(async () => {
      fireEvent.mouseDown(svg, {
        button: 0,
        clientX: 300,
        clientY: 100,
      });
      fireEvent.mouseUp(window, {
        clientX: 300,
        clientY: 100,
      });
    });

    await waitFor(() => {
      const points = JSON.parse(
        screen.getByTestId("trimmed-points-json").textContent ?? "[]",
      ) as Array<{ time: number; value: number }>;
      expect(points).toHaveLength(4);
      expect(
        points.some(
          (point) => Math.abs(point.time - 12.631578947368421) < 0.01,
        ),
      ).toBe(true);
    });
  });
});
