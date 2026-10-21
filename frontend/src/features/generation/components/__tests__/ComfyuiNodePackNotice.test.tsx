import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComfyuiNodePackNotice } from "../ComfyuiNodePackNotice";
import type { ComfyUiNodePackReport } from "../../../../types/RuntimeStatus";

function report(
  overrides: Partial<ComfyUiNodePackReport>,
): ComfyUiNodePackReport {
  return {
    status: "ok",
    packId: "comfyui-vlo",
    requiredVersion: "0.3.0",
    installedVersion: "0.3.0",
    path: "/comfy/custom_nodes/ComfyUI-vlo",
    updateCommand: null,
    ...overrides,
  };
}

describe("ComfyuiNodePackNotice", () => {
  it.each([undefined, report({}), report({ status: "not_checked" })])(
    "stays hidden when there is nothing to fix",
    (value) => {
      const { container } = render(<ComfyuiNodePackNotice report={value} />);

      expect(container).toBeEmptyDOMElement();
    },
  );

  it("shows the installed and required versions with the update command", () => {
    render(
      <ComfyuiNodePackNotice
        report={report({
          status: "outdated",
          installedVersion: "0.2.0",
          updateCommand:
            'git -C "/comfy/custom_nodes/ComfyUI-vlo" pull --ff-only',
        })}
      />,
    );

    expect(screen.getByText("ComfyUI-vlo needs an update")).toBeInTheDocument();
    expect(
      screen.getByText(/ComfyUI-vlo 0\.2\.0 is installed/),
    ).toHaveTextContent("need 0.3.0 or newer");
    expect(
      screen.getByText(
        'git -C "/comfy/custom_nodes/ComfyUI-vlo" pull --ff-only',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Run this, then restart ComfyUI."),
    ).toBeInTheDocument();
  });

  it("points registry installs at ComfyUI-Manager", () => {
    render(
      <ComfyuiNodePackNotice
        report={report({ status: "outdated", installedVersion: "0.2.0" })}
      />,
    );

    expect(
      screen.getByText("Update it from ComfyUI-Manager, then restart ComfyUI."),
    ).toBeInTheDocument();
  });

  it("names a missing pack", () => {
    render(
      <ComfyuiNodePackNotice
        report={report({
          status: "missing",
          installedVersion: null,
          path: null,
          updateCommand:
            'git clone https://github.com/PxTicks/ComfyUI-vlo "/comfy/custom_nodes/ComfyUI-vlo"',
        })}
      />,
    );

    expect(screen.getByText("ComfyUI-vlo is missing")).toBeInTheDocument();
    expect(screen.getByText(/was not found/)).toBeInTheDocument();
  });
});
