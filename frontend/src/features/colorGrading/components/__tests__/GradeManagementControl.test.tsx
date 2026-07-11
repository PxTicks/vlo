import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CustomControlRenderProps } from "../../../panelUI";
import { clearCopiedGradeParameters } from "../../gradeParameters";
import { useGradePresetStore } from "../../useGradePresetStore";
import { GradeManagementControl } from "../GradeManagementControl";

const control: CustomControlRenderProps["control"] = {
  type: "custom",
  label: "Grade management",
  name: "_gradeManagement",
};

describe("GradeManagementControl", () => {
  beforeEach(() => {
    clearCopiedGradeParameters();
    useGradePresetStore.setState({ presets: [] });
  });

  it("copies and pastes the same parameter JSON", () => {
    const onCommitMany = vi.fn();
    render(
      <GradeManagementControl
        control={control}
        value={undefined}
        values={{ exposure: 1, curveMaster: [{ x: 0, y: 0 }], _ui: true }}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="grade"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy grade" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste grade" }));
    expect(onCommitMany).toHaveBeenCalledWith({
      exposure: 1,
      curveMaster: [{ x: 0, y: 0 }],
    });
  });

  it("saves a reusable named preset", () => {
    render(
      <GradeManagementControl
        control={control}
        value={undefined}
        values={{ saturation: 0.8 }}
        onCommit={vi.fn()}
        onCommitMany={vi.fn()}
        groupId="grade"
      />,
    );
    fireEvent.change(screen.getByLabelText("Preset name"), {
      target: { value: "Muted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save grade preset" }));
    expect(useGradePresetStore.getState().presets[0]).toMatchObject({
      name: "Muted",
      parameters: { saturation: 0.8 },
    });
  });
});
