import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlRenderer } from "../ControlRenderer";
import type {
  ControlCommitOptions,
  ControlDefinition,
} from "../../../panelUI/types";

const AMOUNT: ControlDefinition = {
  type: "slider",
  name: "amount",
  label: "Amount",
  min: 0,
  max: 100,
  step: 1,
};

function renderSlider(transformId?: string) {
  const onCommit = vi.fn<(value: unknown, options?: ControlCommitOptions) => void>();
  const { container } = render(
    <ControlRenderer
      control={AMOUNT}
      value={0}
      onCommit={onCommit}
      groupId="mask_grow"
      transformId={transformId}
    />,
  );
  const root = container.querySelector(".MuiSlider-root") as HTMLElement;
  root.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 100, bottom: 10, width: 100, height: 10, x: 0, y: 0 }) as DOMRect;
  const drag = (...xs: number[]) => {
    fireEvent.mouseDown(root, { clientX: xs[0], clientY: 5, button: 0, buttons: 1 });
    xs.slice(1).forEach((clientX) =>
      fireEvent.mouseMove(document, { clientX, clientY: 5, buttons: 1 }),
    );
    fireEvent.mouseUp(document, { clientX: xs.at(-1), clientY: 5 });
  };
  return { onCommit, drag };
}

describe("TransformSliderControl history", () => {
  it("keeps a drag that commits per tick in one history entry", () => {
    // No transformId: the default group is not materialized yet, so there is
    // nothing to preview against and every tick commits.
    const { onCommit, drag } = renderSlider(undefined);

    drag(10, 40, 80);

    const coalesce = onCommit.mock.calls.map(([, options]) => options?.historyCoalesce);
    expect(coalesce.length).toBeGreaterThan(1);
    const [first] = coalesce;
    expect(coalesce.every((entry) => entry?.key === first?.key)).toBe(true);
    expect(coalesce.slice(0, -1).every((entry) => entry?.end === false)).toBe(true);
    expect(coalesce.at(-1)?.end).toBe(true);
    expect(onCommit.mock.calls.at(-1)?.[0]).toBe(80);

    onCommit.mockClear();
    drag(20, 30);
    const nextKey = onCommit.mock.calls[0]?.[1]?.historyCoalesce?.key;
    expect(nextKey).toBeDefined();
    expect(nextKey).not.toBe(first?.key);
  });

  it("closes the history entry with the release commit when previewing", () => {
    const { onCommit, drag } = renderSlider("grow-transform");

    drag(10, 40, 80);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(80, {
      historyCoalesce: { key: expect.any(String), end: true },
    });
  });
});
