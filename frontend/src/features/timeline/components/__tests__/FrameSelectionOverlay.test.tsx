import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { FrameSelectionOverlay } from "../FrameSelectionOverlay";
import { useExtractStore } from "../../../../core/extract/useExtractStore";

const onConfirmSelection = vi.fn();
const setOnConfirmSelection = vi.fn();
const exitFrameSelectionMode = vi.fn();

vi.mock("../../../../core/extract/useExtractStore", () => {
  const fn = vi.fn();
  return { useExtractStore: fn };
});

describe("FrameSelectionOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (useExtractStore as unknown as Mock).mockImplementation(
      (selector: unknown) => {
        const state = {
          frameSelectionMode: true,
          exitFrameSelectionMode,
          onConfirmSelection,
          setOnConfirmSelection,
        };
        if (typeof selector === "function") {
          return selector(state);
        }
        return state;
      },
    );
  });

  it("does not bubble frame extraction clicks to the timeline container", () => {
    const parentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <FrameSelectionOverlay />
      </div>,
    );

    fireEvent.click(screen.getByText("Extract Current Frame"));

    expect(onConfirmSelection).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
