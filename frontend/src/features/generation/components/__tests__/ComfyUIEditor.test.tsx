// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
import { waitForAppReady } from "../../services/workflowSyncController";
import { useGenerationStore } from "../../useGenerationStore";

function resetStore(overrides: Record<string, unknown> = {}) {
  useGenerationStore.setState({
    comfyuiDirectUrl: null,
    editorNeedsReconnect: false,
    editorReconnectSignal: 0,
    connectionStatus: "disconnected",
    ...overrides,
  } as never);
}

beforeEach(() => {
  resetStore();
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
});
