import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { livePreviewParamStore } from "../../../../core/liveParams/livePreviewParamStore";
import type { CustomControlRenderProps } from "../../../panelUI";
import { ToneShapingControl } from "../ToneShapingControl";

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

  it("commits both linked parameters from keyboard-accessible handles", () => {
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
    const shadow = screen.getByRole("slider", {
      name: "Shadow lift handle",
    });
    fireEvent.keyDown(shadow, { key: "ArrowRight" });

    expect(onCommitMany).toHaveBeenCalledWith({
      toeAmount: 0.05,
      toeSoftness: 0.025,
    });

    const highlight = screen.getByRole("slider", {
      name: "Highlight rolloff handle",
    });
    fireEvent.keyDown(highlight, { key: "ArrowDown" });
    expect(onCommitMany).toHaveBeenCalledWith({
      kneeThreshold: 0.99,
      kneeSoftness: 0.015,
    });
  });
});
