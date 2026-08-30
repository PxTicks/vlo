import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPreSaveHooks } from "../../../../core/persistence/preSaveHooks";
import { useProjectStore } from "../../../project";
import { projectPersistenceService } from "../../../project/services/ProjectPersistenceService";
import { useGenerationStore } from "../../useGenerationStore";
import { installGenerationPanelPersistence } from "../installGenerationPanelPersistence";
import type { GenerationPanelSnapshot } from "../generationPanelSnapshot";

const savedSnapshot: GenerationPanelSnapshot = {
  version: 1,
  workflowId: "wan-i2v.json",
  targetResolution: 720,
  inputs: [],
  replayState: { version: 2, textValues: { "6:text": "a cat" } },
};

function openProject(id: string): void {
  useProjectStore.setState({
    project: { id } as never,
    rootHandle: {} as FileSystemDirectoryHandle,
  });
}

describe("installGenerationPanelPersistence", () => {
  let uninstall: (() => void) | null = null;
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    write = vi
      .spyOn(projectPersistenceService, "writeGenerationPanel")
      .mockResolvedValue(undefined as never);
    vi.spyOn(projectPersistenceService, "readGenerationPanel").mockResolvedValue(
      {
        documentType: "vlo.generation-panel",
        schemaVersion: 1,
        updated_at: 0,
        panel: JSON.parse(JSON.stringify(savedSnapshot)),
      },
    );
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    useProjectStore.setState({ project: null, rootHandle: null });
    useGenerationStore.setState({
      pendingPanelSnapshot: null,
      isRestoringPanelSnapshot: false,
      selectedWorkflowId: null,
    });
  });

  it("hands the saved state back when a project opens", async () => {
    openProject("project-a");
    uninstall = installGenerationPanelPersistence();

    await vi.waitFor(() =>
      expect(useGenerationStore.getState().pendingPanelSnapshot).toEqual(
        savedSnapshot,
      ),
    );
  });

  it("does not overwrite the saved state before it has been restored", async () => {
    openProject("project-a");
    uninstall = installGenerationPanelPersistence();
    await vi.waitFor(() =>
      expect(useGenerationStore.getState().pendingPanelSnapshot).not.toBeNull(),
    );

    useGenerationStore.setState({ selectedWorkflowId: "something-else.json" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(write).not.toHaveBeenCalled();
  });

  it("saves panel changes once they settle", async () => {
    openProject("project-a");
    uninstall = installGenerationPanelPersistence();
    await vi.waitFor(() =>
      expect(useGenerationStore.getState().pendingPanelSnapshot).not.toBeNull(),
    );

    // The panel restored the saved state; from here the store is authoritative.
    useGenerationStore.setState({
      pendingPanelSnapshot: null,
      selectedWorkflowId: "flux.json",
      workflowInputs: [],
      mediaInputs: {},
    });

    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      version: 1,
      workflowId: "flux.json",
    });
  });

  it("does not overwrite the saved state while a restore is running", async () => {
    openProject("project-a");
    uninstall = installGenerationPanelPersistence();
    await vi.waitFor(() =>
      expect(useGenerationStore.getState().pendingPanelSnapshot).not.toBeNull(),
    );

    // A restore in progress has loaded the workflow but not the rest of the
    // state yet; that half-restored panel is not what belongs on disk.
    useGenerationStore.setState({
      isRestoringPanelSnapshot: true,
      selectedWorkflowId: "wan-i2v.json",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).not.toHaveBeenCalled();

    // Only a completed restore hands the panel over.
    useGenerationStore.setState({
      isRestoringPanelSnapshot: false,
      pendingPanelSnapshot: null,
      selectedWorkflowId: "wan-i2v.json",
      workflowInputs: [],
      mediaInputs: {},
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite a project that has nothing saved", async () => {
    vi.spyOn(projectPersistenceService, "readGenerationPanel").mockResolvedValue(
      {
        documentType: "vlo.generation-panel",
        schemaVersion: 1,
        updated_at: 0,
        panel: null,
      },
    );
    openProject("project-a");
    uninstall = installGenerationPanelPersistence();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(useGenerationStore.getState().pendingPanelSnapshot).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps live panel state when the editor remounts inside a project", async () => {
    openProject("project-a");
    useGenerationStore.setState({ selectedWorkflowId: "flux.json" });

    uninstall = installGenerationPanelPersistence();
    await vi.advanceTimersByTimeAsync(2_000);

    // The saved state is not re-applied over what the panel is already showing.
    expect(useGenerationStore.getState().pendingPanelSnapshot).toBeNull();
    expect(useGenerationStore.getState().selectedWorkflowId).toBe("flux.json");
  });

  it("flushes pending panel state when the project is saved", async () => {
    openProject("project-a");
    uninstall = installGenerationPanelPersistence();
    await vi.waitFor(() =>
      expect(useGenerationStore.getState().pendingPanelSnapshot).not.toBeNull(),
    );

    useGenerationStore.setState({
      pendingPanelSnapshot: null,
      selectedWorkflowId: "flux.json",
    });

    await runPreSaveHooks();

    expect(write).toHaveBeenCalledTimes(1);
  });
});
