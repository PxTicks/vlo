import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MaskCropPaddingControl } from "../MaskCropPaddingControl";

function ControlledPadding() {
  const [value, setValue] = useState(0.1);
  return (
    <MaskCropPaddingControl
      label="Mask crop padding"
      value={value}
      onChange={setValue}
    />
  );
}

describe("MaskCropPaddingControl", () => {
  it("offers 0–100% by default, stretches to 300%, and returns to the standard range", () => {
    render(<ControlledPadding />);
    const slider = screen.getByRole("slider", { name: "Mask crop padding" });
    const custom = screen.getByLabelText("Custom crop padding");
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "1");
    expect(custom).toHaveValue(10);

    fireEvent.change(custom, { target: { value: "300" } });
    fireEvent.blur(custom);
    expect(screen.getByText("300% (custom)")).toBeInTheDocument();
    expect(custom).toHaveValue(300);
    // The track stretches to the override instead of pinning the thumb at
    // 100%, where a click would silently replace it.
    expect(slider).toHaveAttribute("aria-valuemax", "3");
    expect(slider).toHaveAttribute("aria-valuenow", "3");

    fireEvent.change(slider, { target: { value: "0.75" } });
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(custom).toHaveValue(75);
    expect(slider).toHaveAttribute("aria-valuemax", "1");
  });

  it("refuses invalid overrides and accepts zero and fractional percentages", () => {
    render(<ControlledPadding />);
    const custom = screen.getByLabelText("Custom crop padding");
    for (const value of ["-1", "", "1e999"]) {
      fireEvent.change(custom, { target: { value } });
      fireEvent.blur(custom);
      expect(custom).toHaveValue(10);
    }
    fireEvent.change(custom, { target: { value: "0" } });
    fireEvent.blur(custom);
    expect(screen.getByText("0%")).toBeInTheDocument();
    fireEvent.change(custom, { target: { value: "125.5" } });
    fireEvent.blur(custom);
    expect(screen.getByText("125.5% (custom)")).toBeInTheDocument();
  });

  it("disables both controls together", () => {
    render(
      <MaskCropPaddingControl
        label="Crop padding"
        value={0.1}
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole("slider")).toBeDisabled();
    expect(screen.getByLabelText("Custom crop padding")).toBeDisabled();
  });
});
