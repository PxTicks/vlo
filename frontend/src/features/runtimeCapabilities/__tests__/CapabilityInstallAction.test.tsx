import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelRuntimeCapabilityInstall,
  getBackendLifecycle,
  getRuntimeCapability,
  getRuntimeCapabilityInstall,
  restartBackend,
  startRuntimeCapabilityInstall,
} from "../../../services/runtimeApi";
import type {
  BackendLifecycleState,
  RuntimeCapability,
  RuntimeCapabilityInstallJob,
} from "../../../types/RuntimeStatus";
import { CapabilityFailureNotice } from "../components/CapabilityFailureNotice";
import { useBackendRestartStore } from "../useBackendRestartStore";
import { useRuntimeCapabilityStore } from "../useRuntimeCapabilityStore";

vi.mock("../../../services/runtimeApi", () => ({
  cancelRuntimeCapabilityInstall: vi.fn(),
  getBackendLifecycle: vi.fn(),
  getRuntimeCapabilities: vi.fn(),
  getRuntimeCapability: vi.fn(),
  getRuntimeCapabilityInstall: vi.fn(),
  getRuntimeCapabilityProbe: vi.fn(),
  restartBackend: vi.fn(),
  startRuntimeCapabilityInstall: vi.fn(),
  startRuntimeCapabilityProbe: vi.fn(),
  downloadRuntimeDiagnostics: vi.fn(),
}));

const INSTALL_COMMAND =
  "uv pip install --python /vlo/backend/.venv/bin/python " +
  "-r /vlo/backend/requirements-sam2.txt";

const missingPackage: RuntimeCapability = {
  id: "sam2",
  label: "SAM2",
  state: "blocked",
  canAttempt: false,
  verifiedThrough: "discovered",
  checkedAt: "2026-08-27T12:00:00Z",
  selectedModel: "sam2.1_hiera_large",
  device: null,
  models: [],
  checks: [
    {
      id: "package.sam2",
      status: "fail",
      stage: "environment",
      code: "package_missing",
      summary: "The sam2 package is not installed",
      remediation: {
        kind: "command",
        summary: "Install SAM2 into the backend virtual environment",
        command:
          "uv pip install --python backend/.venv/bin/python " +
          "-r backend/requirements-sam2.txt",
        requiresRestart: true,
      },
    },
  ],
  lastFailure: null,
  install: {
    available: true,
    summary: "Install SAM2 into the backend virtual environment",
    command: INSTALL_COMMAND,
    tool: "uv",
    profileId: "sam2",
    requiresRestart: true,
  },
  restartRequired: false,
};

const lifecycle: BackendLifecycleState = {
  instanceId: "instance-1",
  restartRequired: false,
  reasons: [],
  restartSupported: true,
  blockedReason: null,
};

function seed(capability: RuntimeCapability = missingPackage) {
  useRuntimeCapabilityStore.setState({
    status: "ready",
    capabilities: { [capability.id]: capability },
  });
}

function renderNotice(capability: RuntimeCapability = missingPackage) {
  return render(
    <CapabilityFailureNotice
      capabilityId={capability.id}
      capabilityLabel={capability.label}
      failure={capability.checks.find((check) => check.status === "fail") ?? null}
    />,
  );
}

function job(
  overrides: Partial<RuntimeCapabilityInstallJob> = {},
): RuntimeCapabilityInstallJob {
  return {
    jobId: "job-1",
    jobType: "install-capability",
    status: "succeeded",
    progress: 1,
    message: "SAM2 installed",
    diagnostics: [
      { level: "info", message: `$ ${INSTALL_COMMAND}`, timestamp: 1 },
      { level: "info", message: "Installed 42 packages", timestamp: 2 },
    ],
    result: {
      capabilityId: "sam2",
      installed: true,
      command: INSTALL_COMMAND,
      summary: "Install SAM2 into the backend virtual environment",
      requiresRestart: true,
    },
    ...overrides,
  };
}

describe("installing a capability from the failure notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeCapabilityStore.getState().reset();
    useBackendRestartStore.getState().reset();
    vi.mocked(getBackendLifecycle).mockResolvedValue(lifecycle);
    vi.mocked(getRuntimeCapability).mockResolvedValue({
      capability: { ...missingPackage, restartRequired: true },
      environment: null as never,
    });
  });

  afterEach(() => {
    useRuntimeCapabilityStore.getState().reset();
    useBackendRestartStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it("shows the command that will run, not the one for a terminal", () => {
    seed();
    renderNotice();

    // The printed remediation names a project-relative interpreter for someone
    // pasting it at the repository root. The runner resolves both paths, and
    // the button must not claim to run the other one.
    expect(screen.getByTestId("capability-install-command")).toHaveTextContent(
      INSTALL_COMMAND,
    );
    expect(
      screen.queryByText(/-r backend\/requirements-sam2\.txt$/),
    ).not.toBeInTheDocument();
  });

  it("offers nothing to install for a failure an install cannot fix", () => {
    // The same discipline the download surface follows: no amount of
    // re-running pip puts a missing checkpoint on disk.
    const modelMissing: RuntimeCapability = {
      ...missingPackage,
      checks: [
        {
          id: "model.default",
          status: "fail",
          stage: "discovered",
          code: "model_missing",
          summary: "No SAM2 checkpoint was found",
        },
      ],
    };
    seed(modelMissing);
    renderNotice(modelMissing);

    expect(screen.queryByTestId("capability-install-run")).not.toBeInTheDocument();
  });

  it("runs the install, streams its output, and then asks for a restart", async () => {
    vi.mocked(startRuntimeCapabilityInstall).mockResolvedValue({
      jobId: "job-1",
    });
    vi.mocked(getRuntimeCapabilityInstall).mockResolvedValue(job());
    seed();
    renderNotice();

    fireEvent.click(screen.getByTestId("capability-install-run"));

    await waitFor(() =>
      expect(screen.getByTestId("backend-restart-prompt")).toBeInTheDocument(),
    );
    expect(startRuntimeCapabilityInstall).toHaveBeenCalledWith(
      "sam2",
      expect.anything(),
    );
    // The installer's own output is the progress, and it stays readable after
    // the job has finished.
    fireEvent.click(screen.getByText("Install log"));
    expect(screen.getByTestId("capability-install-log")).toHaveTextContent(
      "Installed 42 packages",
    );
  });

  it("reports a failed install with the installer's own words", async () => {
    vi.mocked(startRuntimeCapabilityInstall).mockResolvedValue({
      jobId: "job-1",
    });
    vi.mocked(getRuntimeCapabilityInstall).mockResolvedValue(
      job({
        status: "failed",
        error:
          "The install command exited with status 1: " +
          "error: no matching distribution for sam2",
        result: undefined,
      }),
    );
    seed();
    renderNotice();

    fireEvent.click(screen.getByTestId("capability-install-run"));

    await waitFor(() =>
      expect(screen.getByTestId("capability-install-error")).toHaveTextContent(
        "no matching distribution",
      ),
    );
    // Still offered, because a failed install is usually a fixable one.
    expect(screen.getByTestId("capability-install-run")).toHaveTextContent(
      "Try again",
    );
  });

  it("cancels through the backend, not just the poll", async () => {
    vi.mocked(startRuntimeCapabilityInstall).mockResolvedValue({
      jobId: "job-1",
    });
    vi.mocked(getRuntimeCapabilityInstall).mockResolvedValue(
      job({ status: "running", result: undefined }),
    );
    vi.mocked(cancelRuntimeCapabilityInstall).mockResolvedValue(
      job({ status: "cancelled", result: undefined }),
    );
    seed();
    renderNotice();

    fireEvent.click(screen.getByTestId("capability-install-run"));
    const cancel = await screen.findByTestId("capability-install-cancel");
    fireEvent.click(cancel);

    // Abandoning the poll would leave an installer writing packages into the
    // environment the user just decided against.
    await waitFor(() =>
      expect(cancelRuntimeCapabilityInstall).toHaveBeenCalledWith(
        "sam2",
        "job-1",
      ),
    );
    useRuntimeCapabilityStore.getState().reset();
  });

  it("cancels once the job id lands, when the click beat the response", async () => {
    // Aborting the POST would not undo a submission the backend has already
    // accepted: it would only stop us learning which job to cancel, leaving
    // the UI claiming a cancellation while the installer kept writing.
    let releaseSubmit: (value: { jobId: string }) => void = () => {};
    vi.mocked(startRuntimeCapabilityInstall).mockReturnValue(
      new Promise((resolve) => {
        releaseSubmit = resolve;
      }),
    );
    vi.mocked(getRuntimeCapabilityInstall).mockResolvedValue(
      job({ status: "cancelled", result: undefined }),
    );
    vi.mocked(cancelRuntimeCapabilityInstall).mockResolvedValue(
      job({ status: "cancelled", result: undefined }),
    );
    seed();
    renderNotice();

    fireEvent.click(screen.getByTestId("capability-install-run"));
    fireEvent.click(await screen.findByTestId("capability-install-cancel"));
    expect(cancelRuntimeCapabilityInstall).not.toHaveBeenCalled();

    releaseSubmit({ jobId: "job-1" });

    await waitFor(() =>
      expect(cancelRuntimeCapabilityInstall).toHaveBeenCalledWith(
        "sam2",
        "job-1",
      ),
    );
  });

  it("keeps asking for a restart even once the checks pass", () => {
    // The environment is fixed and the process is not: the out-of-process
    // probe reads the disk this install just wrote, while the backend serving
    // it resolved its imports before that.
    const installed: RuntimeCapability = {
      ...missingPackage,
      state: "available_unverified",
      canAttempt: true,
      checks: [],
      restartRequired: true,
    };
    seed(installed);
    render(
      <CapabilityFailureNotice
        capabilityId="sam2"
        capabilityLabel="SAM2"
        failure={null}
      />,
    );

    expect(screen.getByTestId("backend-restart-prompt")).toBeInTheDocument();
  });
});

describe("the restart prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeCapabilityStore.getState().reset();
    useBackendRestartStore.getState().reset();
  });

  afterEach(() => {
    useBackendRestartStore.getState().reset();
    vi.unstubAllGlobals();
  });

  function renderPrompt(state: Partial<BackendLifecycleState> = {}) {
    vi.mocked(getBackendLifecycle).mockResolvedValue({
      ...lifecycle,
      restartRequired: true,
      ...state,
    });
    seed({ ...missingPackage, restartRequired: true });
    return renderNotice({ ...missingPackage, restartRequired: true });
  }

  it("waits for a new process rather than for a reply", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    vi.mocked(restartBackend).mockResolvedValue({
      restarting: true,
      instanceId: "instance-1",
    });
    vi.mocked(getBackendLifecycle)
      .mockResolvedValueOnce({ ...lifecycle, restartRequired: true })
      // The process we asked to go is still answering. Reloading here would
      // land the page back on the backend that has not restarted yet.
      .mockResolvedValueOnce({ ...lifecycle, restartRequired: true })
      // Then the socket goes, which is the normal middle of a restart.
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue({ ...lifecycle, instanceId: "instance-2" });

    seed({ ...missingPackage, restartRequired: true });
    renderNotice({ ...missingPackage, restartRequired: true });
    await waitFor(() =>
      expect(screen.getByTestId("restart-backend")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("restart-backend"));

    await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 8_000 });
  }, 15_000);

  it("says so plainly when the backend cannot restart itself", async () => {
    renderPrompt({ restartSupported: false });

    await waitFor(() =>
      expect(
        screen.getByText(/cannot restart itself/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("restart-backend")).not.toBeInTheDocument();
  });

  it("gives the backend's reason, not a generic one", async () => {
    // A developer on `uvicorn --reload` can restart perfectly well — just not
    // from in here, because the supervisor owns the port. Saying "cannot
    // restart itself" and stopping would send them looking for a bug.
    renderPrompt({
      restartSupported: false,
      restartUnsupportedReason:
        "This backend runs under a supervisor (uvicorn --reload, or " +
        "--workers), which owns the port. Restart the server itself.",
    });

    await waitFor(() =>
      expect(screen.getByTestId("restart-unsupported")).toHaveTextContent(
        /supervisor/,
      ),
    );
  });

  it("warns before a restart would destroy work in flight", async () => {
    renderPrompt({ blockedReason: "1 GPU job is still running (Export)." });

    await waitFor(() =>
      expect(screen.getByTestId("restart-blocked-reason")).toHaveTextContent(
        "still running",
      ),
    );
    // Refusing outright would be wrong: it is the user's work and their call.
    expect(screen.getByTestId("restart-backend-force")).toBeInTheDocument();
  });
});
