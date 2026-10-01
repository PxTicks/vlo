import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getComfyuiInstallStatus: vi.fn(),
  getRuntimeSettings: vi.fn(),
  installComfyui: vi.fn(),
  pickComfyuiDirectory: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  verifyComfyuiInstall: vi.fn(),
}));

vi.mock("../../../services/runtimeApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/runtimeApi")
  >("../../../services/runtimeApi");
  return {
    ...actual,
    getComfyuiInstallStatus: api.getComfyuiInstallStatus,
    getRuntimeSettings: api.getRuntimeSettings,
    installComfyui: api.installComfyui,
    pickComfyuiDirectory: api.pickComfyuiDirectory,
    updateRuntimeSettings: api.updateRuntimeSettings,
    verifyComfyuiInstall: api.verifyComfyuiInstall,
  };
});

import { ComfyUiSetupPrompt } from "../ComfyUiSetupPrompt";

describe("ComfyUiSetupPrompt", () => {
  beforeEach(() => {
    api.getComfyuiInstallStatus.mockResolvedValue({
      phase: "idle",
      running: false,
    });
    api.getRuntimeSettings.mockResolvedValue({
      recommendations: { shouldPromptForComfyuiInstallDir: true },
    });
    api.updateRuntimeSettings.mockReset();
    api.updateRuntimeSettings.mockResolvedValue({});
    api.installComfyui.mockReset();
    api.pickComfyuiDirectory.mockReset();
    api.verifyComfyuiInstall.mockReset();
  });

  it("explicitly prompts for an existing install or a new installation", async () => {
    render(<ComfyUiSetupPrompt />);

    expect(
      await screen.findByRole("heading", { name: "Connect vlo to ComfyUI" }),
    ).toBeInTheDocument();
    const actions = screen.getAllByRole("button");
    expect(actions[0]).toHaveAccessibleName("Install ComfyUI For Me");
    expect(actions[1]).toHaveAccessibleName("Choose Existing Install");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Verify" }),
    ).not.toBeInTheDocument();
  });

  it("persists a declined generative AI choice and closes", async () => {
    render(<ComfyUiSetupPrompt />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue without generative AI",
      }),
    );

    await waitFor(() => {
      expect(api.updateRuntimeSettings).toHaveBeenCalledWith({
        comfyuiInstallDirPromptStatus: "declined",
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Connect vlo to ComfyUI" }),
      ).not.toBeInTheDocument();
    });
  });

  it("can be dismissed locally with Escape", async () => {
    render(<ComfyUiSetupPrompt />);

    await screen.findByRole("heading", { name: "Connect vlo to ComfyUI" });
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Connect vlo to ComfyUI" }),
      ).not.toBeInTheDocument();
    });
  });

  it("closes locally when persisting the opt-out fails", async () => {
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.updateRuntimeSettings.mockRejectedValueOnce(new Error("offline"));
    render(<ComfyUiSetupPrompt />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue without generative AI",
      }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Connect vlo to ComfyUI" }),
      ).not.toBeInTheDocument();
    });
    expect(warningSpy).toHaveBeenCalled();
    warningSpy.mockRestore();
  });

  it("lets a typed install location supersede a picker that never returns", async () => {
    let resolvePicker: (value: unknown) => void = () => {};
    api.pickComfyuiDirectory.mockReturnValue(
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
    );
    api.installComfyui.mockResolvedValue({
      phase: "cloning",
      running: true,
      targetPath: "/home/me/ComfyUI",
      message: "Cloning ComfyUI…",
      error: null,
    });
    render(<ComfyUiSetupPrompt />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Install ComfyUI For Me" }),
    );

    expect(
      await screen.findByText(/folder picker opened in a separate window/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Install ComfyUI For Me" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Continue without generative AI" }),
    ).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Install location"), {
      target: { value: "  /home/me  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install Here" }));

    await waitFor(() => {
      expect(api.installComfyui).toHaveBeenCalledWith("/home/me");
    });
    expect(await screen.findByText("Cloning ComfyUI…")).toBeInTheDocument();

    // The abandoned picker finally answering must not start a second install.
    resolvePicker({ cancelled: false, path: "/elsewhere", verification: null });
    await Promise.resolve();
    expect(api.installComfyui).toHaveBeenCalledTimes(1);
  });

  it("follows the running install's latest output beneath the progress bar", async () => {
    api.getComfyuiInstallStatus
      .mockResolvedValueOnce({
        phase: "installing_requirements",
        running: true,
        targetPath: "/home/me/ComfyUI",
        message: "Installing ComfyUI requirements…",
        error: null,
        logLine: "Collecting torch",
      })
      .mockResolvedValue({
        phase: "installing_requirements",
        running: true,
        targetPath: "/home/me/ComfyUI",
        message: "Installing ComfyUI requirements…",
        error: null,
        logLine: "Downloading torch-2.12.0.whl (900.0 MB) — 43%",
      });
    render(<ComfyUiSetupPrompt />);

    expect(
      await screen.findByTestId("comfyui-install-log-line"),
    ).toHaveTextContent("Collecting torch");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    // The status poll runs every 1.5s.
    await waitFor(
      () => {
        expect(screen.getByTestId("comfyui-install-log-line")).toHaveTextContent(
          "Downloading torch-2.12.0.whl (900.0 MB) — 43%",
        );
      },
      { timeout: 3000 },
    );
  });

  it("keeps the last output line visible when the install fails", async () => {
    api.getComfyuiInstallStatus.mockResolvedValue({
      phase: "failed",
      running: false,
      targetPath: "/home/me/ComfyUI",
      message: "ComfyUI installation failed.",
      error: "Command returned non-zero exit status 1.",
      logLine: "ERROR: No matching distribution found for torch",
    });
    render(<ComfyUiSetupPrompt />);

    expect(
      await screen.findByTestId("comfyui-install-log-line"),
    ).toHaveTextContent("ERROR: No matching distribution found for torch");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("verifies a typed existing install before accepting it", async () => {
    api.pickComfyuiDirectory.mockReturnValue(new Promise(() => {}));
    api.verifyComfyuiInstall.mockResolvedValue({
      valid: true,
      installPath: "/opt/ComfyUI",
      warnings: [],
    });
    render(<ComfyUiSetupPrompt />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Choose Existing Install" }),
    );
    fireEvent.change(await screen.findByLabelText("ComfyUI folder"), {
      target: { value: "/opt/ComfyUI/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Folder" }));

    await waitFor(() => {
      expect(api.updateRuntimeSettings).toHaveBeenCalledWith({
        comfyuiInstallDir: "/opt/ComfyUI",
        comfyuiInstallDirPromptStatus: "accepted",
      });
    });
    expect(api.verifyComfyuiInstall).toHaveBeenCalledWith("/opt/ComfyUI/");
  });

  it("rejects a typed folder that is not a ComfyUI install", async () => {
    api.pickComfyuiDirectory.mockReturnValue(new Promise(() => {}));
    api.verifyComfyuiInstall.mockResolvedValue({
      valid: false,
      installPath: "/tmp",
      warnings: [
        "main.py did not contain a recognized ComfyUI entry-point marker.",
      ],
    });
    render(<ComfyUiSetupPrompt />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Choose Existing Install" }),
    );
    fireEvent.change(await screen.findByLabelText("ComfyUI folder"), {
      target: { value: "/tmp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Folder" }));

    expect(
      await screen.findByText(/recognized ComfyUI entry-point marker/),
    ).toBeInTheDocument();
    expect(api.updateRuntimeSettings).not.toHaveBeenCalled();
    expect(screen.getByLabelText("ComfyUI folder")).toBeInTheDocument();
  });

  it("keeps the path field available when the picker cannot open", async () => {
    api.pickComfyuiDirectory.mockRejectedValue(
      new Error("The native directory picker could not open."),
    );
    render(<ComfyUiSetupPrompt />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Install ComfyUI For Me" }),
    );

    expect(
      await screen.findByText("The native directory picker could not open."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Install location")).toBeInTheDocument();
    expect(
      screen.queryByText(/folder picker opened in a separate window/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Install ComfyUI For Me" }),
    ).toBeEnabled();
  });
});
