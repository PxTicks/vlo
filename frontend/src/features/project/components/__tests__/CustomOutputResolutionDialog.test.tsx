import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomOutputResolutionDialog } from "../CustomOutputResolutionDialog";

function renderDialog(value = 1080) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <CustomOutputResolutionDialog
      value={value}
      aspectRatio="16:9"
      onApply={onApply}
      onClose={onClose}
    />,
  );
  return { onApply, onClose, input: screen.getByLabelText("Short edge") };
}

describe("CustomOutputResolutionDialog", () => {
  it("applies a valid even short edge", () => {
    const { onApply, input } = renderDialog();
    expect(input).toHaveValue("1080");

    fireEvent.change(input, { target: { value: "1440" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith(1440);
  });

  it("strips non-digits as the user types", () => {
    const { input } = renderDialog();
    fireEvent.change(input, { target: { value: "7a2-0px" } });
    expect(input).toHaveValue("720");
  });

  it("blocks odd or out-of-range values with an explanation", () => {
    const { onApply, input } = renderDialog();

    fireEvent.change(input, { target: { value: "721" } });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a supported even short edge.",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("closes from the cancel button", () => {
    const { onClose, onApply } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
