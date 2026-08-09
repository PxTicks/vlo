import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const sliderPropsSpy = vi.hoisted(() => vi.fn());

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  return {
    ...actual,
    Slider: (props: Readonly<Record<string, unknown>>) => {
      sliderPropsSpy(props);
      return <input aria-label="mock slider" type="range" />;
    },
  };
});

import { SliderControl } from "../SliderControl";

function renderSlider(
  optionalHandlers: {
    onMouseDown?: React.MouseEventHandler<HTMLSpanElement>;
    onMouseUp?: React.MouseEventHandler<HTMLSpanElement>;
  } = {},
): void {
  render(
    <SliderControl
      label="Test"
      value={0}
      min={0}
      max={1}
      step={0.1}
      onChange={vi.fn()}
      onChangeCommitted={vi.fn()}
      onInputCommit={vi.fn()}
      {...optionalHandlers}
    />,
  );
}

describe("SliderControl", () => {
  beforeEach(() => sliderPropsSpy.mockClear());

  it("omits absent mouse handlers so MUI keeps its internal handlers", () => {
    renderSlider();
    const props = sliderPropsSpy.mock.calls.at(-1)?.[0];
    expect(props).not.toHaveProperty("onMouseDown");
    expect(props).not.toHaveProperty("onMouseUp");
  });

  it("stays within its grid cell at narrow panel widths", () => {
    renderSlider();
    const slider = screen.getByRole("slider", { name: "mock slider" });
    const root = slider.parentElement;

    expect(root).toHaveStyle({
      boxSizing: "border-box",
      minWidth: 0,
      maxWidth: "100%",
      width: "100%",
      paddingLeft: "8px",
      paddingRight: "8px",
    });
  });

  it("forwards supplied mouse handlers", () => {
    const onMouseDown = vi.fn();
    const onMouseUp = vi.fn();
    renderSlider({ onMouseDown, onMouseUp });
    const props = sliderPropsSpy.mock.calls.at(-1)?.[0];
    expect(props).toHaveProperty("onMouseDown", onMouseDown);
    expect(props).toHaveProperty("onMouseUp", onMouseUp);
  });
});
