import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyuiNodePackNotice } from "../ComfyuiNodePackNotice";
import type { ComfyUiNodePackReport } from "../../../../types/RuntimeStatus";
import {
  getComfyuiInstallStatus,
  updateComfyuiVloNodePack,
  type ComfyuiInstallStatus,
} from "../../../../services/runtimeApi";

vi.mock("../../../../services/runtimeApi", () => ({
  getComfyuiInstallStatus: vi.fn(),
  updateComfyuiVloNodePack: vi.fn(),
}));

const PULL_COMMAND = 'git -C "/comfy/custom_nodes/ComfyUI-vlo" pull --ff-only';

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
    managed: false,
    ...overrides,
  };
}

function installStatus(
  overrides: Partial<ComfyuiInstallStatus>,
): ComfyuiInstallStatus {
  return {
    phase: "updating_nodes",
    running: true,
    targetPath: "/comfy",
    message: "Updating ComfyUI-vlo…",
    error: null,
    logLine: null,
    ...overrides,
  };
}

const outdatedManaged = report({
  status: "outdated",
  installedVersion: "0.2.0",
  updateCommand: PULL_COMMAND,
  managed: true,
});

describe("ComfyuiNodePackNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([undefined, report({}), report({ status: "not_checked" })])(
    "stays hidden when there is nothing to fix",
    (value) => {
      const { container } = render(
        <ComfyuiNodePackNotice report={value} onUpdateFinished={vi.fn()} />,
      );

      expect(container).toBeEmptyDOMElement();
    },
  );

  it("gives a pack vlo did not clone only the command to run", () => {
    render(
      <ComfyuiNodePackNotice
        report={report({
          status: "outdated",
          installedVersion: "0.2.0",
          updateCommand: PULL_COMMAND,
        })}
        onUpdateFinished={vi.fn()}
      />,
    );

    expect(screen.getByText("ComfyUI-vlo needs an update")).toBeInTheDocument();
    expect(
      screen.getByText(/ComfyUI-vlo 0\.2\.0 is installed/),
    ).toHaveTextContent("need 0.3.0 or newer");
    expect(screen.getByText(PULL_COMMAND)).toBeInTheDocument();
    expect(
      screen.getByText("Run this, then restart ComfyUI."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update ComfyUI-vlo" }),
    ).not.toBeInTheDocument();
  });

  it("points registry installs at ComfyUI-Manager", () => {
    render(
      <ComfyuiNodePackNotice
        report={report({ status: "outdated", installedVersion: "0.2.0" })}
        onUpdateFinished={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Update it from ComfyUI-Manager, then restart ComfyUI."),
    ).toBeInTheDocument();
  });

  it("names a missing pack without offering an in-app update", () => {
    render(
      <ComfyuiNodePackNotice
        report={report({
          status: "missing",
          installedVersion: null,
          path: null,
          updateCommand:
            'git clone https://github.com/PxTicks/ComfyUI-vlo "/comfy/custom_nodes/ComfyUI-vlo"',
        })}
        onUpdateFinished={vi.fn()}
      />,
    );

    expect(screen.getByText("ComfyUI-vlo is missing")).toBeInTheDocument();
    expect(screen.getByText(/was not found/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update ComfyUI-vlo" }),
    ).not.toBeInTheDocument();
  });

  it("updates a pack vlo cloned and follows the job to the end", async () => {
    vi.useFakeTimers();
    vi.mocked(updateComfyuiVloNodePack).mockResolvedValue(installStatus({}));
    vi.mocked(getComfyuiInstallStatus).mockResolvedValue(
      installStatus({
        phase: "complete",
        running: false,
        message:
          "ComfyUI-vlo is now 0.3.0. ComfyUI was restarted to load it.",
      }),
    );
    const onUpdateFinished = vi.fn();
    const { rerender } = render(
      <ComfyuiNodePackNotice
        report={outdatedManaged}
        onUpdateFinished={onUpdateFinished}
      />,
    );
    expect(
      screen.getByText("Or run this yourself, then restart ComfyUI."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update ComfyUI-vlo" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(updateComfyuiVloNodePack).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Updating ComfyUI-vlo…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update ComfyUI-vlo" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(onUpdateFinished).toHaveBeenCalledTimes(1);

    // The re-read report is now current: the outcome stays until dismissed.
    rerender(
      <ComfyuiNodePackNotice
        report={report({ managed: true })}
        onUpdateFinished={onUpdateFinished}
      />,
    );
    expect(
      screen.getByText(
        "ComfyUI-vlo is now 0.3.0. ComfyUI was restarted to load it.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows why an update could not start and offers it again", async () => {
    vi.mocked(updateComfyuiVloNodePack).mockRejectedValue(
      new Error(
        "ComfyUI is running, but vlo did not start it. Stop ComfyUI, then update.",
      ),
    );
    render(
      <ComfyuiNodePackNotice
        report={outdatedManaged}
        onUpdateFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update ComfyUI-vlo" }));

    expect(
      await screen.findByText(
        "ComfyUI is running, but vlo did not start it. Stop ComfyUI, then update.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update ComfyUI-vlo" }),
    ).toBeInTheDocument();
  });

  it("keeps a failed restart visible once the report is already current", async () => {
    vi.useFakeTimers();
    vi.mocked(updateComfyuiVloNodePack).mockResolvedValue(installStatus({}));
    vi.mocked(getComfyuiInstallStatus).mockResolvedValue(
      installStatus({
        phase: "failed",
        running: false,
        message: "ComfyUI-vlo is now 0.3.0.",
        error: "ComfyUI could not be restarted: no such file",
      }),
    );
    const { rerender } = render(
      <ComfyuiNodePackNotice
        report={outdatedManaged}
        onUpdateFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update ComfyUI-vlo" }));
    await act(async () => {
      await Promise.resolve();
    });
    // The pull landed, so a status refresh mid-job already reads as current;
    // the job's progress must not vanish with the warning.
    rerender(
      <ComfyuiNodePackNotice
        report={report({ managed: true })}
        onUpdateFinished={vi.fn()}
      />,
    );
    expect(screen.getByText("Updating ComfyUI-vlo…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.getByText("ComfyUI-vlo is now 0.3.0.")).toBeInTheDocument();
    expect(
      screen.getByText("ComfyUI could not be restarted: no such file"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows how a started update failed", async () => {
    vi.useFakeTimers();
    vi.mocked(updateComfyuiVloNodePack).mockResolvedValue(installStatus({}));
    vi.mocked(getComfyuiInstallStatus).mockResolvedValue(
      installStatus({
        phase: "failed",
        running: false,
        message: "ComfyUI-vlo was not updated.",
        error:
          "ComfyUI-vlo has local changes, so vlo left it alone. Commit or discard them, then update.",
      }),
    );
    render(
      <ComfyuiNodePackNotice
        report={outdatedManaged}
        onUpdateFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update ComfyUI-vlo" }));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.getByText(/has local changes/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update ComfyUI-vlo" }),
    ).toBeInTheDocument();
  });
});
