import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CustomControlRenderProps } from "../../../panelUI";
import { extensionParameterPresetRegistry } from "../../../extensions/registry/ExtensionParameterPresetRegistry";
import type {
  ExtensionApiScope,
  ExtensionParameterPresetRegistration,
} from "../../../extensions/types";
import { clearCopiedGradeParameters } from "../../gradeParameters";
import { useGradePresetStore } from "../../useGradePresetStore";
import { GradeManagementControl } from "../GradeManagementControl";

const control: CustomControlRenderProps["control"] = {
  type: "custom",
  label: "Grade management",
  name: "_gradeManagement",
};

function registerExtensionPreset(): ExtensionParameterPresetRegistration {
  const scope = {
    extension: { id: "example.grading-tools", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <T,>(resource: T): T => resource,
    report: vi.fn(),
  } as unknown as ExtensionApiScope;
  return extensionParameterPresetRegistry.bind(scope).register({
    id: "bleach-bypass",
    apiVersion: 1,
    label: "Bleach bypass",
    target: { kind: "filter", filterName: "ColorGradeFilter" },
    parameters: { contrast: 1.18, saturation: 0.62 },
  });
}

describe("GradeManagementControl", () => {
  beforeEach(() => {
    clearCopiedGradeParameters();
    useGradePresetStore.setState({ presets: [] });
  });

  afterEach(cleanup);

  it("copies and pastes the same parameter JSON", async () => {
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
    await waitFor(() => {
      expect(onCommitMany).toHaveBeenCalledWith({
        exposure: 1,
        curveMaster: [{ x: 0, y: 0 }],
      });
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

  it("applies a contributed preset and drops it when the extension deactivates", async () => {
    const registration = registerExtensionPreset();
    const onCommitMany = vi.fn();
    const user = userEvent.setup();
    render(
      <GradeManagementControl
        control={control}
        value={undefined}
        values={{ saturation: 1 }}
        onCommit={vi.fn()}
        onCommitMany={onCommitMany}
        groupId="grade"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Bleach bypass" }));
    expect(onCommitMany).toHaveBeenCalledWith({
      contrast: 1.18,
      saturation: 0.62,
    });

    void registration.dispose();
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: "Bleach bypass" }),
      ).toBeNull();
    });
  });
});
