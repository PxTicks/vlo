import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeCapabilities,
  getRuntimeCapability,
} from "../../../services/runtimeApi";
import type {
  RuntimeCapability,
  RuntimeEnvironmentSnapshot,
} from "../../../types/RuntimeStatus";
import { RuntimeDiagnosticsPanel } from "../components/RuntimeDiagnosticsPanel";
import { useRuntimeCapabilityStore } from "../useRuntimeCapabilityStore";

vi.mock("../../../services/runtimeApi", () => ({
  getRuntimeCapabilities: vi.fn(),
  getRuntimeCapability: vi.fn(),
}));

const environment: RuntimeEnvironmentSnapshot = {
  checkedAt: "2026-08-25T12:00:00Z",
  python: {
    executable: "<project>/backend/.venv/bin/python",
    version: "3.11.9",
    implementation: "CPython",
    prefix: "<project>/backend/.venv",
    virtualEnv: true,
  },
  platform: { system: "Linux", release: "6.6.0", machine: "x86_64" },
  torch: {
    torchVersion: "2.4.0",
    cudaAvailable: true,
    cudaBuildVersion: "12.1",
    mpsAvailable: false,
    devices: [{ index: 0, name: "RTX 4090", totalMemoryMb: 24564 }],
    error: null,
  },
  probe: { ok: true, timedOut: false, error: null },
  packages: { torch: "2.4.0" },
  directories: [
    {
      id: "samAudio.cache",
      path: "<project>/projects/.sam_audio_cache",
      exists: true,
      readable: true,
      writable: true,
    },
  ],
  searchPaths: { samAudio: ["<project>/backend/assets/models/sam_audio"] },
  huggingFace: { tokenPresent: false, tokenSource: null },
  offline: { hfHubOffline: false, transformersOffline: false },
};

const blockedSamAudio: RuntimeCapability = {
  id: "sam-audio",
  label: "SAM-Audio",
  state: "blocked",
  canAttempt: false,
  verifiedThrough: "discovered",
  checkedAt: "2026-08-25T12:00:00Z",
  selectedModel: "sam-audio-large-tv",
  device: { requested: "auto", resolved: "cuda", proven: false, fallback: false },
  models: [],
  checks: [
    {
      id: "model.default",
      status: "pass",
      stage: "discovered",
      summary: "sam-audio-large-tv checkpoint found",
    },
    {
      id: "package.sam_audio",
      status: "fail",
      stage: "environment",
      code: "package_missing",
      summary: "The sam_audio package is not installed",
      remediation: {
        kind: "command",
        summary: "Install the SAM-Audio package into the backend environment",
        command:
          "uv pip install --python backend/.venv/bin/python -r backend/requirements-sam-audio.txt",
        requiresRestart: true,
      },
    },
  ],
  lastFailure: null,
};

describe("RuntimeDiagnosticsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeCapabilityStore.getState().reset();
    vi.mocked(getRuntimeCapabilities).mockResolvedValue({
      capabilities: [blockedSamAudio],
      environment,
    });
  });

  afterEach(() => {
    useRuntimeCapabilityStore.getState().reset();
  });

  it("shows the state, how far it was verified, and the remedy", async () => {
    render(<RuntimeDiagnosticsPanel />);

    expect(await screen.findByTestId("capability-card-sam-audio")).toBeInTheDocument();
    expect(screen.getByTestId("capability-state-sam-audio")).toHaveTextContent(
      "Blocked",
    );
    // The state alone is ambiguous; the card has to say how far the evidence
    // reaches.
    expect(screen.getByText(/Files found/)).toBeInTheDocument();
    expect(
      screen.getByText("The sam_audio package is not installed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "uv pip install --python backend/.venv/bin/python -r backend/requirements-sam-audio.txt",
      ),
    ).toBeInTheDocument();
  });

  it("says it is checking while the first read is in flight", async () => {
    let resolvePayload: (value: unknown) => void = () => {};
    vi.mocked(getRuntimeCapabilities).mockReturnValue(
      new Promise((resolve) => {
        resolvePayload = resolve;
      }) as never,
    );

    render(<RuntimeDiagnosticsPanel />);

    expect(await screen.findByTestId("diagnostics-checking")).toBeInTheDocument();

    resolvePayload({ capabilities: [blockedSamAudio], environment });

    await waitFor(() => {
      expect(screen.queryByTestId("diagnostics-checking")).not.toBeInTheDocument();
    });
  });

  it("rechecks one capability on demand", async () => {
    render(<RuntimeDiagnosticsPanel />);
    await screen.findByTestId("capability-card-sam-audio");

    vi.mocked(getRuntimeCapability).mockResolvedValue({
      capability: {
        ...blockedSamAudio,
        state: "available_unverified",
        canAttempt: true,
        verifiedThrough: "environment",
        checks: [blockedSamAudio.checks[0]],
      },
      environment: { ...environment, checkedAt: "2026-08-25T12:05:00Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));

    await waitFor(() => {
      expect(screen.getByTestId("capability-state-sam-audio")).toHaveTextContent(
        "Installed, unverified",
      );
    });
    expect(getRuntimeCapability).toHaveBeenCalledWith("sam-audio", {
      refresh: true,
    });
  });

  it("dates each card and the environment separately", async () => {
    // Cards are rechecked one at a time, so a single panel-level timestamp
    // would put a stale time on freshly checked data.
    render(<RuntimeDiagnosticsPanel />);
    await screen.findByTestId("capability-card-sam-audio");

    expect(screen.getByTestId("capability-card-sam-audio")).toHaveTextContent(
      /checked /,
    );
    expect(screen.getByTestId("environment-card")).toHaveTextContent("Checked");
  });

  it("refreshes the environment alongside a single recheck", async () => {
    render(<RuntimeDiagnosticsPanel />);
    await screen.findByTestId("capability-card-sam-audio");

    vi.mocked(getRuntimeCapability).mockResolvedValue({
      capability: blockedSamAudio,
      environment: {
        ...environment,
        torch: { ...environment.torch!, devices: [], cudaAvailable: false },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));

    await waitFor(() => {
      expect(screen.getByTestId("environment-card")).toHaveTextContent(
        "CPU only",
      );
    });
  });

  it("says the devices are unknown when the probe did not report", async () => {
    // "CPU only" is a finding — a probe ran and saw no accelerator. A probe
    // that failed or never ran establishes nothing.
    vi.mocked(getRuntimeCapabilities).mockResolvedValue({
      capabilities: [blockedSamAudio],
      environment: {
        ...environment,
        torch: null,
        probe: { ok: false, timedOut: true, error: "probe timed out after 20s" },
      },
    });

    render(<RuntimeDiagnosticsPanel />);

    const card = await screen.findByTestId("environment-card");
    expect(card).toHaveTextContent("Unknown — probe timed out after 20s");
    expect(card).not.toHaveTextContent("CPU only");
  });

  it("shows a recorded failure that is not blocking", async () => {
    vi.mocked(getRuntimeCapabilities).mockResolvedValue({
      capabilities: [
        {
          ...blockedSamAudio,
          state: "available_unverified",
          canAttempt: true,
          checks: [blockedSamAudio.checks[0]],
          lastFailure: {
            code: "out_of_memory",
            summary: "Ran out of memory while loading the model",
            stage: "loaded",
            occurredAt: "2026-08-25T12:03:00Z",
          },
        },
      ],
      environment,
    });

    render(<RuntimeDiagnosticsPanel />);

    expect(
      await screen.findByTestId("capability-last-failure-sam-audio"),
    ).toHaveTextContent("Out of memory");
    // Recorded, not held against the feature.
    expect(screen.getByTestId("capability-state-sam-audio")).toHaveTextContent(
      "Installed, unverified",
    );
  });

  it("lists every check, including the ones that were skipped", async () => {
    render(<RuntimeDiagnosticsPanel />);
    await screen.findByTestId("capability-card-sam-audio");

    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));

    expect(
      await screen.findByTestId("capability-check-package.sam_audio"),
    ).toHaveTextContent("package_missing");
    expect(screen.getByTestId("environment-card")).toHaveTextContent("3.11.9");
    expect(screen.getByTestId("environment-card")).toHaveTextContent("RTX 4090");
  });
});
