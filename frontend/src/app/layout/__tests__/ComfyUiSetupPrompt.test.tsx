import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getComfyuiInstallStatus: vi.fn(),
  getRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
}));

vi.mock("../../../services/runtimeApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/runtimeApi")
  >("../../../services/runtimeApi");
  return {
    ...actual,
    getComfyuiInstallStatus: api.getComfyuiInstallStatus,
    getRuntimeSettings: api.getRuntimeSettings,
    updateRuntimeSettings: api.updateRuntimeSettings,
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
    api.updateRuntimeSettings.mockResolvedValue({});
  });

  it("explicitly prompts for an existing install or a new installation", async () => {
    render(<ComfyUiSetupPrompt />);

    expect(
      await screen.findByRole("heading", { name: "Connect vlo to ComfyUI" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose ComfyUI folder" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Install ComfyUI" }),
    ).toBeInTheDocument();
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
});
