import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { livePreviewParamStore } from "../../../../core/liveParams/livePreviewParamStore";
import type {
  CustomControlRenderProps,
  SliderControlProps,
} from "../../../panelUI";
import { ToneShapingControl } from "../ToneShapingControl";

vi.mock("../../../panelUI", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../panelUI")>();
  return {
    ...actual,
    SliderControl: ({
      label,
      value,
      min,
      max,
      step,
      onChange,
      onChangeCommitted,
    }: SliderControlProps) => (
      <input
        aria-label={label}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) =>
          onChange(event.nativeEvent, Number(event.currentTarget.value))
        }
        onMouseUp={(event) =>
          onChangeCommitted(
            event.nativeEvent,
            Number(event.currentTarget.value),
          )
        }
      />
    ),
  };
});

const control: CustomControlRenderProps["control"] = {
  type: "custom",
  label: "Tone shaping",
  name: "_toneShaping",
};

function props(
  values: Readonly<Record<string, unknown>>,
  onCommitMany = vi.fn(),
): CustomControlRenderProps {
  return {
    control,
    value: undefined,
    values,
    onCommit: vi.fn(),
    onCommitMany,
    groupId: "color_grade_tone",
    transformId: "grade-1",
  };
}

describe("ToneShapingControl", () => {
  afterEach(() => livePreviewParamStore.clearAll());

  it("commits both linked parameters from a quick control", () => {
    const onCommitMany = vi.fn();
    render(
      <ToneShapingControl
        {...props(
          {
            kneeThreshold: 1,
            kneeSoftness: 0,
            toeAmount: 0,
            toeSoftness: 0,
          },
          onCommitMany,
        )}
      />,
    );
    const shadow = screen.getByRole("slider", { name: "Shadow lift" });
    fireEvent.change(shadow, { target: { value: "0.5" } });
    fireEvent.mouseUp(shadow);

    expect(onCommitMany).toHaveBeenCalledWith({
      toeAmount: 0.5,
      toeSoftness: 0.25,
    });
  });
});
