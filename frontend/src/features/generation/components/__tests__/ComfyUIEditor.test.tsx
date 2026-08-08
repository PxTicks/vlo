// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  state: { isReady: false },
  readActive: vi.fn(),
  health: vi.fn(),
  onGraphChanged: vi.fn(
    (_handler: (snapshot: unknown) => void): (() => void) => () => {},
  ),
  onHealthChanged: vi.fn(
    (_handler: (health: unknown) => void): (() => void) => () => {},
  ),
  onIframeGeneration: vi.fn(
    (_handler: (generation: unknown) => void): (() => void) => () => {},
  ),
  notifyIframeReloaded: vi.fn(),
  isPeerBooting: vi.fn(() => false),
  waitForReady: vi.fn(),
}));

vi.mock("../../services/workflowBridge", () => ({
  buildWorkflowResultFromGraphData: vi.fn(),
}));
vi.mock("../../services/iframeBridgeClient", () => ({
  iframeBridge: {
    get isReady() {
      return bridgeMocks.state.isReady;
    },
    readActive: bridgeMocks.readActive,
    health: bridgeMocks.health,
    onGraphChanged: bridgeMocks.onGraphChanged,
    onHealthChanged: bridgeMocks.onHealthChanged,
    onIframeGeneration: bridgeMocks.onIframeGeneration,
    notifyIframeReloaded: bridgeMocks.notifyIframeReloaded,
    isPeerBooting: bridgeMocks.isPeerBooting,
    waitForReady: bridgeMocks.waitForReady,
  },
}));
vi.mock("../../services/workflowSyncController", () => ({
  // Never resolves: keeps the init effect parked so it can't churn state
  // during the render-branch assertions.
  waitForAppReady: vi.fn(() => new Promise<boolean>(() => {})),
  injectWorkflowAndRead: vi.fn(),
  readWorkflowWithRetry: vi.fn(),
}));

import { ComfyUIEditor } from "../ComfyUIEditor";
import {
  injectWorkflowAndRead,
  readWorkflowWithRetry,
  waitForAppReady,
} from "../../services/workflowSyncController";
import { buildWorkflowResultFromGraphData } from "../../services/workflowBridge";
import { useGenerationStore } from "../../useGenerationStore";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";

function resetStore(overrides: Record<string, unknown> = {}) {
  useGenerationStore.setState({
    comfyuiDirectUrl: null,
    editorNeedsReconnect: false,
    editorReconnectSignal: 0,
    connectionStatus: "disconnected",
    selectedWorkflowId: null,
    isWorkflowReady: false,
    syncedGraphData: null,
    workflowWarning: null,
    registerEditor: vi.fn(),
    unregisterEditor: vi.fn(),
    ...overrides,
  } as never);
}

beforeEach(() => {
  resetStore();
  useTimelineSelectionStore.getState().exitSelectionMode();
  useExtractStore.getState().setOnConfirmSelection(null);
  useExtractStore.getState().setOnCancelSelection(null);
  bridgeMocks.state.isReady = false;
  bridgeMocks.isPeerBooting.mockReturnValue(false);
  bridgeMocks.readActive.mockResolvedValue(null);
  bridgeMocks.health.mockResolvedValue(null);
  vi.mocked(waitForAppReady).mockImplementation(
    () => new Promise<boolean>(() => undefined),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComfyUIEditor without a ComfyUI URL", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <ComfyUIEditor open={false} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an unavailable notice when opened without a URL", () => {
    render(<ComfyUIEditor open onClose={() => {}} />);
    expect(
      screen.getByText(/ComfyUI URL not available/i),
    ).toBeInTheDocument();
  });
});

describe("ComfyUIEditor with a ComfyUI URL", () => {
  beforeEach(() => {
    resetStore({ comfyuiDirectUrl: "http://comfy.local" });
  });

  it("renders the editor chrome and a same-origin iframe", () => {
    render(<ComfyUIEditor open onClose={() => {}} />);

    expect(screen.getByText("ComfyUI Node Editor")).toBeInTheDocument();

    const iframe = screen.getByTitle("ComfyUI Node Editor");
    expect(iframe).toHaveAttribute("src", "/comfyui-frame/");

    const openLink = screen.getByRole("link");
    expect(openLink).toHaveAttribute("href", "/comfyui-frame/");
    expect(openLink).toHaveAttribute("target", "_blank");
  });

  it("opens advanced settings from the timeline-selection split button", () => {
    render(<ComfyUIEditor open onClose={() => {}} />);

    expect(screen.getByTestId("comfyui-select-from-timeline")).toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("comfyui-timeline-selection-settings"),
    );

    expect(screen.getByText("Timeline selection settings")).toBeInTheDocument();
    expect(
      screen.getByText("Apply aspect-ratio processing"),
    ).toBeInTheDocument();
    expect(screen.getByText("Mask crop")).toBeInTheDocument();
  });

  it("temporarily closes the iframe and launches range then track selection", () => {
    useGenerationStore.setState({ editorOpen: true });
    render(<ComfyUIEditor open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("comfyui-select-from-timeline"));

    const selectionState = useTimelineSelectionStore.getState();
    expect(selectionState.selectionMode).toBe(true);
    expect(selectionState.selectionStage).toBe("range");
    expect(selectionState.selectionIncludeModeEnabled).toBe(true);
    expect(selectionState.selectionAllowIncludeAll).toBe(true);
    expect(useGenerationStore.getState().editorOpen).toBe(false);

    useExtractStore.getState().onCancelSelection?.();
    expect(useGenerationStore.getState().editorOpen).toBe(true);
  });

  it("invokes onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    render(<ComfyUIEditor open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /close editor/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the connecting overlay by default", () => {
    render(<ComfyUIEditor open onClose={() => {}} />);
    expect(screen.getByText(/Connecting to ComfyUI/i)).toBeInTheDocument();
    expect(screen.queryByText(/Reconnecting to ComfyUI/i)).toBeNull();
  });

  it("does not claim to reconnect when app init fails without a reload", async () => {
    // The init effect flips editorNeedsReconnect to false on mount, so seeding
    // it isn't enough; drive the real path where waitForAppReady reports the
    // app never came up (backend stays disconnected, so no forced reload).
    vi.mocked(waitForAppReady).mockResolvedValueOnce(false);

    render(<ComfyUIEditor open onClose={() => {}} />);

    expect(await screen.findByText(/Connecting to ComfyUI/i)).toBeInTheDocument();
    expect(screen.queryByText(/Restarting ComfyUI editor/i)).toBeNull();
  });

  it("reports that ComfyUI is still starting when the bridge is booting", async () => {
    bridgeMocks.isPeerBooting.mockReturnValue(true);
    vi.mocked(waitForAppReady).mockResolvedValueOnce(false);

    render(<ComfyUIEditor open onClose={() => {}} />);

    expect(
      await screen.findByText(/ComfyUI is still starting/i),
    ).toBeInTheDocument();
    expect(useGenerationStore.getState().editorNeedsReconnect).toBe(false);
  });

  it("reports an actual iframe restart", async () => {
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      editorReconnectSignal: 1,
    });

    render(<ComfyUIEditor open onClose={() => {}} />);

    expect(
      await screen.findByText(/Restarting ComfyUI editor/i),
    ).toBeInTheDocument();
    expect(bridgeMocks.notifyIframeReloaded).toHaveBeenCalledOnce();
  });

  it("initializes an already-synced selected workflow through iframe injection", async () => {
    const syncWorkflow = vi.fn();
    const setWorkflowLoading = vi.fn();
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      selectedWorkflowId: "selected.json",
      isWorkflowReady: true,
      syncedGraphData: { nodes: [{ id: 1, type: "LoadImage" }] },
      syncWorkflow,
      setWorkflowLoading,
    });
    vi.mocked(waitForAppReady).mockResolvedValue(true);
    vi.mocked(injectWorkflowAndRead).mockResolvedValue({
      ok: true,
      deferred: false,
      reason: null,
      workflowResult: {
        workflow: null,
        graphData: { nodes: [{ id: 1, type: "LoadImage" }] },
        inputs: [],
        filename: "selected.json",
        workflowInstanceId: "workflow-1",
        revision: 1,
      },
      warnings: { missingNodeTypes: ["Missing"], missingModels: [] },
    });

    render(<ComfyUIEditor open onClose={() => undefined} />);

    await waitFor(() => expect(injectWorkflowAndRead).toHaveBeenCalled());
    expect(syncWorkflow).toHaveBeenCalledWith(
      null,
      { nodes: [{ id: 1, type: "LoadImage" }] },
      [],
      {
        bridgeIdentity: {
          workflowInstanceId: "workflow-1",
          revision: 1,
        },
      },
    );
    expect(useGenerationStore.getState().workflowWarning).toEqual({
      missingNodeTypes: ["Missing"],
      missingModels: [],
    });
    expect(screen.queryByText(/Connecting to ComfyUI/i)).not.toBeInTheDocument();
  });

  it("loads the selected workflow through the store when no synced graph is reusable", async () => {
    const loadWorkflow = vi.fn().mockResolvedValue(undefined);
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      selectedWorkflowId: "selected.json",
      isWorkflowReady: false,
      syncedGraphData: null,
      loadWorkflow,
    });
    vi.mocked(waitForAppReady).mockResolvedValue(true);
    render(<ComfyUIEditor open onClose={() => undefined} />);

    await waitFor(() =>
      expect(loadWorkflow).toHaveBeenCalledWith("selected.json"),
    );
    expect(screen.queryByText(/Connecting to ComfyUI/i)).not.toBeInTheDocument();
  });

  it("reads the iframe workflow when no workflow is selected", async () => {
    const syncWorkflow = vi.fn();
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      selectedWorkflowId: null,
      syncWorkflow,
    });
    vi.mocked(waitForAppReady).mockResolvedValue(true);
    vi.mocked(readWorkflowWithRetry).mockResolvedValue({
      workflow: null,
      graphData: { nodes: [{ id: 2, type: "Text" }] },
      inputs: [
        {
          id: "2:text",
          nodeId: "2",
          classType: "Text",
          inputType: "text",
          param: "text",
          label: "Text",
          currentValue: "",
          origin: "inferred",
        },
      ],
      filename: "current.json",
      workflowInstanceId: "workflow-2",
      revision: 2,
    });
    render(<ComfyUIEditor open onClose={() => undefined} />);

    await waitFor(() => expect(readWorkflowWithRetry).toHaveBeenCalled());
    expect(syncWorkflow).toHaveBeenCalledWith(
      null,
      { nodes: [{ id: 2, type: "Text" }] },
      [
        {
          id: "2:text",
          nodeId: "2",
          classType: "Text",
          inputType: "text",
          param: "text",
          label: "Text",
          currentValue: "",
          origin: "inferred",
        },
      ],
      {
        bridgeIdentity: {
          workflowInstanceId: "workflow-2",
          revision: 2,
        },
      },
    );
  });

  it("marks reconnect without claiming an iframe restart when workflow restoration fails", async () => {
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      selectedWorkflowId: "selected.json",
      isWorkflowReady: true,
      syncedGraphData: { nodes: [] },
    });
    vi.mocked(waitForAppReady).mockResolvedValue(true);
    vi.mocked(injectWorkflowAndRead).mockResolvedValue({
      ok: false,
      deferred: false,
      reason: "workflow unreadable",
      workflowResult: null,
      warnings: null,
    });
    render(<ComfyUIEditor open onClose={() => undefined} />);
    await waitFor(() =>
      expect(useGenerationStore.getState().editorNeedsReconnect).toBe(true),
    );
    expect(screen.getByText(/Connecting to ComfyUI/i)).toBeInTheDocument();
    expect(screen.queryByText(/Restarting ComfyUI editor/i)).toBeNull();
  });

  it("captures the latest active workflow when the editor closes", async () => {
    const registerWorkflowFromEditor = vi.fn().mockResolvedValue(undefined);
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      registerWorkflowFromEditor,
    });
    bridgeMocks.readActive.mockResolvedValue({
      graphData: { nodes: [{ id: 3 }] },
      filename: "edited.json",
      isModified: true,
      workflowInstanceId: "workflow-3",
      revision: 3,
      fingerprint: "fingerprint-3",
    });
    vi.mocked(buildWorkflowResultFromGraphData).mockReturnValue({
      workflow: null,
      graphData: { nodes: [{ id: 3 }] },
      inputs: [],
      filename: "edited.json",
      workflowInstanceId: "workflow-3",
      revision: 3,
    });
    const { rerender } = render(
      <ComfyUIEditor open onClose={() => undefined} />,
    );
    rerender(<ComfyUIEditor open={false} onClose={() => undefined} />);

    await waitFor(() =>
      expect(registerWorkflowFromEditor).toHaveBeenCalledWith(
        null,
        { nodes: [{ id: 3 }] },
        [],
        "edited.json",
        { workflowInstanceId: "workflow-3", revision: 3 },
      ),
    );
  });

  it("commits bridge graph-changed events into the store", async () => {
    const registerWorkflowFromEditor = vi.fn().mockResolvedValue(undefined);
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      registerWorkflowFromEditor,
    });
    const handlers: Array<(snapshot: unknown) => void> = [];
    bridgeMocks.onGraphChanged.mockImplementation((handler) => {
      handlers.push(handler);
      return () => {};
    });
    vi.mocked(buildWorkflowResultFromGraphData).mockReturnValue({
      workflow: null,
      graphData: { nodes: [{ id: 5 }] },
      inputs: [],
      filename: "live.json",
      workflowInstanceId: "workflow-5",
      revision: 5,
    });

    render(<ComfyUIEditor open onClose={() => undefined} />);
    expect(handlers.length).toBeGreaterThan(0);

    for (const handler of handlers) {
      handler({
        graphData: { nodes: [{ id: 5 }] },
        filename: "live.json",
        isModified: true,
        workflowInstanceId: "workflow-5",
        revision: 5,
        fingerprint: "fingerprint-5",
      });
    }

    await waitFor(() =>
      expect(registerWorkflowFromEditor).toHaveBeenCalledWith(
        null,
        { nodes: [{ id: 5 }] },
        [],
        "live.json",
        { workflowInstanceId: "workflow-5", revision: 5 },
      ),
    );
  });

  it("health-checks the bridge on window focus once ready", async () => {
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
    });
    bridgeMocks.state.isReady = true;
    bridgeMocks.health.mockResolvedValue({
      appReady: true,
      backendConnected: true,
      version: 1,
    });
    vi.mocked(waitForAppReady).mockResolvedValue(true);
    vi.mocked(readWorkflowWithRetry).mockResolvedValue({
      workflow: null,
      graphData: { nodes: [] },
      inputs: [],
      filename: null,
      workflowInstanceId: "workflow-empty",
      revision: 0,
    });
    render(<ComfyUIEditor open onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.queryByText(/Connecting to ComfyUI/i)).not.toBeInTheDocument(),
    );
    bridgeMocks.health.mockClear();
    fireEvent.focus(window);
    await waitFor(() => expect(bridgeMocks.health).toHaveBeenCalled());
  });
});
