// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerControls } from "../PlayerControls";

describe("PlayerControls", () => {
  it("renders fit and fullscreen controls when handlers are provided", () => {
    render(
      <PlayerControls
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onFitView={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onOpenExport={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Fit to Screen" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enter Fullscreen" }),
    ).toBeInTheDocument();
  });

  it("calls the fullscreen handler and updates its label in fullscreen mode", () => {
    const onToggleFullscreen = vi.fn();

    const { rerender } = render(
      <PlayerControls
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onFitView={vi.fn()}
        onToggleFullscreen={onToggleFullscreen}
        onOpenExport={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enter Fullscreen" }));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);

    rerender(
      <PlayerControls
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onFitView={vi.fn()}
        onToggleFullscreen={onToggleFullscreen}
        isFullscreen={true}
        onOpenExport={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Exit Fullscreen" }),
    ).toBeInTheDocument();
  });
});
