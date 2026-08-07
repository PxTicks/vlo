import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorTrack } from "../EditorTrack";

function renderTrack() {
  const handlers = {
    onSetCrop: vi.fn(),
    onUpdateRange: vi.fn(),
    onSelectRange: vi.fn(),
    onSeek: vi.fn(),
  };
  const view = render(
    <EditorTrack
      durationTicks={1000}
      cropStartTicks={100}
      cropEndTicks={900}
      ranges={[
        {
          id: "range-1",
          startSourceTicks: 200,
          endSourceTicks: 400,
          isActive: true,
        },
      ]}
      selectedRangeId="range-1"
      playheadTicks={300}
      {...handlers}
    />,
  );
  const track = view.container.firstElementChild as HTMLElement;
  Object.defineProperty(track, "setPointerCapture", {
    value: vi.fn(),
  });
  Object.defineProperty(track, "hasPointerCapture", {
    value: vi.fn(() => true),
  });
  Object.defineProperty(track, "releasePointerCapture", {
    value: vi.fn(),
  });
  track.getBoundingClientRect = () =>
    ({
      left: 0,
      width: 1000,
    }) as DOMRect;
  return { ...view, track, handlers };
}

describe("EditorTrack", () => {
  it("keeps crop handles above the wider playhead hit target", () => {
    renderTrack();

    expect(screen.getByLabelText("Crop start")).toHaveStyle({ zIndex: "4" });
    expect(screen.getByLabelText("Playhead")).toHaveStyle({ zIndex: "3" });
  });

  it("scrubs on the empty track and during pointer movement", () => {
    const { track, handlers } = renderTrack();

    fireEvent.pointerDown(track, { clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });

    expect(handlers.onSelectRange).toHaveBeenCalledWith(null);
    expect(handlers.onSeek).toHaveBeenNthCalledWith(1, 250);
    expect(handlers.onSeek).toHaveBeenNthCalledWith(2, 500);
    expect(track.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("drags the playhead directly", () => {
    const { track, handlers } = renderTrack();

    fireEvent.pointerDown(screen.getByLabelText("Playhead"), {
      clientX: 300,
      pointerId: 8,
    });
    fireEvent.pointerMove(track, { clientX: 650, pointerId: 8 });
    fireEvent.pointerUp(track, { pointerId: 8 });

    expect(handlers.onSeek).toHaveBeenCalledWith(650);
  });

  it("drags both crop handles", () => {
    const { track, handlers } = renderTrack();

    fireEvent.pointerDown(screen.getByLabelText("Crop start"), {
      clientX: 100,
      pointerId: 2,
    });
    fireEvent.pointerMove(track, { clientX: 300, pointerId: 2 });
    expect(handlers.onSetCrop).toHaveBeenCalledWith(300, 900);

    fireEvent.pointerDown(screen.getByLabelText("Crop end"), {
      clientX: 900,
      pointerId: 3,
    });
    fireEvent.pointerMove(track, { clientX: 700, pointerId: 3 });
    expect(handlers.onSetCrop).toHaveBeenCalledWith(100, 700);
  });

  it("moves and resizes ranges", () => {
    const { track, handlers } = renderTrack();
    const range = screen.getByLabelText("Range range-1");

    fireEvent.pointerDown(range, { clientX: 250, pointerId: 4 });
    fireEvent.pointerMove(track, { clientX: 500, pointerId: 4 });
    expect(handlers.onSelectRange).toHaveBeenCalledWith("range-1");
    expect(handlers.onUpdateRange).toHaveBeenCalledWith(
      "range-1",
      450,
      650,
    );

    fireEvent.pointerDown(screen.getByLabelText("Range range-1 start"), {
      pointerId: 5,
    });
    fireEvent.pointerMove(track, { clientX: 150, pointerId: 5 });
    expect(handlers.onUpdateRange).toHaveBeenCalledWith("range-1", 150, 400);

    fireEvent.pointerDown(screen.getByLabelText("Range range-1 end"), {
      pointerId: 6,
    });
    fireEvent.pointerMove(track, { clientX: 450, pointerId: 6 });
    expect(handlers.onUpdateRange).toHaveBeenCalledWith("range-1", 200, 450);
  });

  it("clamps pointer positions to the timeline", () => {
    const { track, handlers } = renderTrack();
    fireEvent.pointerDown(track, { clientX: -100, pointerId: 7 });
    fireEvent.pointerMove(track, { clientX: 1200, pointerId: 7 });
    expect(handlers.onSeek).toHaveBeenNthCalledWith(1, 0);
    expect(handlers.onSeek).toHaveBeenNthCalledWith(2, 1000);
  });
});
