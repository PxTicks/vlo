import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RangeMaskComponent } from "../../../../types/Components";
import { mediaSecondsToTick } from "../../../renderer/utils/mediaTime";
import { RangeMaskSection } from "../RangeMaskSection";

function component(
  id: string,
  start: number,
  end: number,
  isActive: boolean,
): RangeMaskComponent {
  return {
    id,
      type: "range_mask",
    parameters: {
      startSourceTicks: mediaSecondsToTick(start),
      endSourceTicks: mediaSecondsToTick(end),
      isActive,
    },
  } as unknown as RangeMaskComponent;
}

describe("RangeMaskSection", () => {
  it("renders formatted masks and delegates all controls", () => {
    const handlers = {
      onAdd: vi.fn(),
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onToggleActive: vi.fn(),
    };
    render(
      <RangeMaskSection
        rangeMaskComponents={[
          component("one", 1, 2.5, true),
          component("two", 3, 4, false),
        ]}
        {...handlers}
      />,
    );

    expect(screen.getAllByText("Range 1 — 1.00s–2.50s")).toHaveLength(2);
    expect(screen.getByText("Range 2 — 3.00s–4.00s")).toBeInTheDocument();
    expect(screen.getByTestId("range-mask-active-list")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("range-mask-add-chip"));
    fireEvent.click(screen.getByTestId("range-mask-chip-one"));
    fireEvent.click(screen.getByTestId("range-mask-edit-two"));
    fireEvent.click(screen.getByTestId("range-mask-remove-two"));
    expect(handlers.onAdd).toHaveBeenCalled();
    expect(handlers.onToggleActive).toHaveBeenCalledWith("one");
    expect(handlers.onEdit).toHaveBeenCalledWith("two");
    expect(handlers.onRemove).toHaveBeenCalledWith("two");
  });

  it("omits the active list when every mask is disabled", () => {
    render(
      <RangeMaskSection
        rangeMaskComponents={[component("one", 0, 1, false)]}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onToggleActive={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId("range-mask-active-list"),
    ).not.toBeInTheDocument();
  });
});
