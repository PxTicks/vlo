import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimelineHeader } from "../TimelineHeader";

describe("TimelineHeader", () => {
  it("stops click propagation when toggling visibility", () => {
    const onToggleVisibility = vi.fn();
    const onToggleMute = vi.fn();
    const parentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <TimelineHeader
          isVisible
          isMuted={false}
          derivedType="visual"
          color="#fff"
          onToggleVisibility={onToggleVisibility}
          onToggleMute={onToggleMute}
        />
      </div>,
    );

    fireEvent.click(screen.getAllByRole("button")[1]);

    expect(onToggleVisibility).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("stops click propagation when toggling mute", () => {
    const onToggleVisibility = vi.fn();
    const onToggleMute = vi.fn();
    const parentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <TimelineHeader
          isVisible
          isMuted={false}
          derivedType="visual"
          color="#fff"
          onToggleVisibility={onToggleVisibility}
          onToggleMute={onToggleMute}
        />
      </div>,
    );

    fireEvent.click(screen.getAllByRole("button")[0]);

    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
