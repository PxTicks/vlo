import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

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

  it("forwards supplied mouse handlers", () => {
    const onMouseDown = vi.fn();
    const onMouseUp = vi.fn();
    renderSlider({ onMouseDown, onMouseUp });
    const props = sliderPropsSpy.mock.calls.at(-1)?.[0];
    expect(props).toHaveProperty("onMouseDown", onMouseDown);
    expect(props).toHaveProperty("onMouseUp", onMouseUp);
  });
});
