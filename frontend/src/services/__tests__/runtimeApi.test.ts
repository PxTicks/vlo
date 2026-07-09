import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockResponse, stubFetch } from "../../testUtils/fetch";
import {
  getRuntimeSettings,
  getRuntimeStatus,
  updateRuntimeSettings,
} from "../runtimeApi";

describe("getRuntimeStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and returns the runtime status with an abort signal", async () => {
    const status = {
      backend: { status: "ready", mode: "development" },
      comfyui: { status: "ready" },
      sam2: { status: "ready" },
    };
    const response = createMockResponse({ json: status });
    const fetchMock = stubFetch(response);
    const controller = new AbortController();

    await expect(
      getRuntimeStatus({ signal: controller.signal }),
    ).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith("/app/status", {
      signal: controller.signal,
    });
  });

  it("fetches runtime settings with an abort signal", async () => {
    const settings = {
      settings: { workflowMode: "default", comfyuiUrl: "http://x" },
      hardware: { vram: { totalMb: null } },
      recommendations: { shouldPromptForHighVram: false },
    };
    const response = createMockResponse({ json: settings });
    const fetchMock = stubFetch(response);
    const controller = new AbortController();

    await expect(
      getRuntimeSettings({ signal: controller.signal }),
    ).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenCalledWith("/app/settings", {
      signal: controller.signal,
    });
  });

  it("patches runtime settings", async () => {
    const payload = {
      settings: { workflowMode: "high_vram", comfyuiUrl: "http://x" },
      hardware: { vram: { totalMb: 49152 } },
      recommendations: { shouldPromptForHighVram: false },
    };
    const response = createMockResponse({ json: payload });
    const fetchMock = stubFetch(response);

    await expect(
      updateRuntimeSettings({ workflowMode: "high_vram" }),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/app/settings", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workflowMode: "high_vram" }),
    });
  });

  it.each([
    [{ error: { message: " nested failure " } }, "nested failure"],
    [{ detail: " detail failure " }, "detail failure"],
    [{ message: " message failure " }, "message failure"],
    [" plain failure ", "plain failure"],
  ])("extracts useful JSON error messages", async (payload, message) => {
    stubFetch(
      createMockResponse({
        status: 503,
        headers: { "content-type": "application/json" },
        text: JSON.stringify(payload),
      }),
    );

    await expect(getRuntimeStatus()).rejects.toThrow(message);
  });

  it("falls back for empty and structurally unhelpful error bodies", async () => {
    stubFetch(
      createMockResponse({ status: 500, text: "" }),
      createMockResponse({
        status: 502,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ detail: ["not", "a", "string"] }),
      }),
    );

    await expect(getRuntimeStatus()).rejects.toThrow(
      "Runtime status request failed (500)",
    );
    await expect(getRuntimeStatus()).rejects.toThrow(
      "Runtime status request failed (502)",
    );
  });

  it("returns malformed JSON text as the error message", async () => {
    stubFetch(
      createMockResponse({
        status: 500,
        headers: { "content-type": "application/json" },
        text: "{broken",
      }),
    );

    await expect(getRuntimeStatus()).rejects.toThrow("{broken");
  });
});
