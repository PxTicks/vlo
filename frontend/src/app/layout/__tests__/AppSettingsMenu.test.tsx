import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettingsMenu } from "../AppSettingsMenu";
import { hostMenuCatalog } from "../../../core/shell/hostMenuCatalog";
import { declareHostMenus } from "../../../core/shell/hostMenus";

declareHostMenus();

const SETTINGS_PAYLOAD = {
  settings: {
    workflowMode: "high_vram",
    comfyuiUrl: "http://127.0.0.1:8188",
    comfyuiInstallDir: "/opt/ComfyUI",
    comfyuiInstallVerification: null,
    highVramPromptStatus: "accepted",
    comfyuiInstallDirPromptStatus: "accepted",
  },
  hardware: {
    vram: { totalMb: 49152, source: "nvidia_smi", meetsHighVramThreshold: true },
    highVramThresholdMb: 49152,
  },
  recommendations: {
    shouldPromptForHighVram: false,
    shouldPromptForComfyuiInstallDir: false,
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/app/settings")) {
        return Promise.resolve(jsonResponse(SETTINGS_PAYLOAD));
      }
      if (url.endsWith("/app/extensions")) {
        return Promise.resolve(jsonResponse({ extensions: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
}

describe("AppSettingsMenu", () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers only install-wide settings", () => {
    render(<AppSettingsMenu />);

    fireEvent.click(screen.getByRole("button", { name: "App Settings" }));

    expect(screen.getByText("RUNTIME")).toBeInTheDocument();
    expect(screen.getByText("Runtime settings")).toBeInTheDocument();
    expect(screen.getByText("EXTENSIONS")).toBeInTheDocument();
    expect(screen.getByText("Manage extensions")).toBeInTheDocument();
    // Project-scoped groups stay in the editor's ProjectSettingsMenu.
    expect(screen.queryByText("ASPECT RATIO")).not.toBeInTheDocument();
    expect(screen.queryByText("LAYOUT")).not.toBeInTheDocument();
  });

  it("publishes a project-free subject the catalogue accepts", async () => {
    render(<AppSettingsMenu />);

    fireEvent.click(screen.getByRole("button", { name: "App Settings" }));

    await waitFor(() => {
      expect(
        hostMenuCatalog.validateSubject("app.settings", {
          slot: "app.settings",
          app: { workflowMode: "high_vram", comfyuiConfigured: true },
        }),
      ).toBe(true);
    });
  });

  it("opens the runtime settings dialog", async () => {
    render(<AppSettingsMenu />);

    fireEvent.click(screen.getByRole("button", { name: "App Settings" }));
    fireEvent.click(screen.getByText("Runtime settings"));

    expect(
      await screen.findByRole("heading", { name: "Runtime Settings" }),
    ).toBeInTheDocument();
  });

  it("opens the extension manager", async () => {
    render(<AppSettingsMenu />);

    fireEvent.click(screen.getByRole("button", { name: "App Settings" }));
    fireEvent.click(screen.getByText("Manage extensions"));

    expect(
      await screen.findByRole("heading", { name: "Extension manager" }),
    ).toBeInTheDocument();
  });

  it("stays usable when the local-runtime API is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    render(<AppSettingsMenu />);

    fireEvent.click(screen.getByRole("button", { name: "App Settings" }));

    expect(await screen.findByText("Runtime settings")).toBeInTheDocument();
  });
});
