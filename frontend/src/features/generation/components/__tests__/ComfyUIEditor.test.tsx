// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("../../services/workflowBridge", () => ({
  buildWorkflowResultFromGraphData: vi.fn(),
  readActiveWorkflowFromIframe: vi.fn(() => null),
  isIframeAppReady: vi.fn(() => false),
  isIframeBackendConnected: vi.fn(() => false),
}));
vi.mock("../../services/preResolvePrompt", () => ({
  isGraphMutationInFlight: vi.fn(() => false),
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
import {
  buildWorkflowResultFromGraphData,
  isIframeAppReady,
  readActiveWorkflowFromIframe,
} from "../../services/workflowBridge";
import { isGraphMutationInFlight } from "../../services/preResolvePrompt";
import { useGenerationStore } from "../../useGenerationStore";

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

  it("invokes onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    render(<ComfyUIEditor open onClose={onClose} />);

    // The OpenInNew control is an anchor (link role); the only button is Close.
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the connecting overlay by default", () => {
    render(<ComfyUIEditor open onClose={() => {}} />);
    expect(screen.getByText(/Connecting to ComfyUI/i)).toBeInTheDocument();
    expect(screen.queryByText(/Reconnecting to ComfyUI/i)).toBeNull();
  });

  it("shows the reconnecting message after app init fails", async () => {
    // The init effect flips editorNeedsReconnect to false on mount, so seeding
    // it isn't enough; drive the real path where waitForAppReady reports the
    // app never came up (backend stays disconnected, so no forced reload).
    vi.mocked(waitForAppReady).mockResolvedValueOnce(false);

    render(<ComfyUIEditor open onClose={() => {}} />);

    expect(
      await screen.findByText(/Reconnecting to ComfyUI/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Connecting to ComfyUI/i)).toBeNull();
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
      },
      warnings: { missingNodeTypes: ["Missing"], missingModels: [] },
    });

    render(<ComfyUIEditor open onClose={() => undefined} />);

    await waitFor(() => expect(injectWorkflowAndRead).toHaveBeenCalled());
    expect(syncWorkflow).toHaveBeenCalledWith(
      null,
      { nodes: [{ id: 1, type: "LoadImage" }] },
      [],
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
      inputs: [{ id: "2:text" }],
      filename: "current.json",
    } as never);
    render(<ComfyUIEditor open onClose={() => undefined} />);

    await waitFor(() => expect(readWorkflowWithRetry).toHaveBeenCalled());
    expect(syncWorkflow).toHaveBeenCalledWith(
      null,
      { nodes: [{ id: 2, type: "Text" }] },
      [{ id: "2:text" }],
    );
  });

  it("marks reconnect when workflow restoration cannot be read", async () => {
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
    expect(
      await screen.findByText(/Reconnecting to ComfyUI/i),
    ).toBeInTheDocument();
  });

  it("captures the latest active workflow when the editor closes", async () => {
    const registerWorkflowFromEditor = vi.fn().mockResolvedValue(undefined);
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      registerWorkflowFromEditor,
    });
    vi.mocked(readActiveWorkflowFromIframe).mockReturnValue({
      graphData: { nodes: [{ id: 3 }] },
      filename: "edited.json",
      isModified: true,
    });
    vi.mocked(buildWorkflowResultFromGraphData).mockReturnValue({
      workflow: null,
      graphData: { nodes: [{ id: 3 }] },
      inputs: [],
      filename: "edited.json",
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
      ),
    );
  });

  it("skips close synchronization while graph mutation is in flight", async () => {
    const registerWorkflowFromEditor = vi.fn();
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      registerWorkflowFromEditor,
    });
    vi.mocked(isGraphMutationInFlight).mockReturnValue(true);
    const { rerender } = render(
      <ComfyUIEditor open onClose={() => undefined} />,
    );
    rerender(<ComfyUIEditor open={false} onClose={() => undefined} />);
    await Promise.resolve();
    expect(readActiveWorkflowFromIframe).not.toHaveBeenCalled();
    expect(registerWorkflowFromEditor).not.toHaveBeenCalled();
    vi.mocked(isGraphMutationInFlight).mockReturnValue(false);
  });

  it("health-checks a visible ready iframe on window focus", async () => {
    const registerWorkflowFromEditor = vi.fn().mockResolvedValue(undefined);
    resetStore({
      comfyuiDirectUrl: "http://comfy.local",
      registerWorkflowFromEditor,
    });
    vi.mocked(isIframeAppReady).mockReturnValue(true);
    vi.mocked(waitForAppReady).mockResolvedValue(true);
    vi.mocked(readWorkflowWithRetry).mockResolvedValue({
      workflow: null,
      graphData: { nodes: [] },
      inputs: [],
      filename: null,
    });
    vi.mocked(readActiveWorkflowFromIframe).mockReturnValue({
      graphData: { nodes: [{ id: 4 }] },
      filename: "focus.json",
      isModified: false,
    });
    vi.mocked(buildWorkflowResultFromGraphData).mockReturnValue({
      workflow: null,
      graphData: { nodes: [{ id: 4 }] },
      inputs: [],
      filename: "focus.json",
    });
    render(<ComfyUIEditor open onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.queryByText(/Connecting to ComfyUI/i)).not.toBeInTheDocument(),
    );
    fireEvent.focus(window);
    await waitFor(() =>
      expect(registerWorkflowFromEditor).toHaveBeenCalled(),
    );
  });
});
