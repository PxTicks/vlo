import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MENU_TREE_VERSION,
  type MenuTreeDefinition,
} from "../../../../core/shell/menuTree";
import { DEFAULT_GENERATION_WORKFLOW_MENU } from "../../workflowMenu";

const getWorkflowMenuDefinition = vi.hoisted(() => vi.fn());

vi.mock("../../services/comfyuiApi", () => ({ getWorkflowMenuDefinition }));

import { useWorkflowMenuDefinition } from "../useWorkflowMenuDefinition";

const SERVED_MENU: MenuTreeDefinition = {
  version: MENU_TREE_VERSION,
  id: "generation.workflows",
  nodes: [
    { id: "custom", kind: "category", label: "Custom", parentId: null, order: 0 },
  ],
  leafPlacements: [{ leafId: "mine.json", parentId: "custom", order: 0 }],
};

describe("useWorkflowMenuDefinition", () => {
  afterEach(() => {
    getWorkflowMenuDefinition.mockReset();
    vi.restoreAllMocks();
  });

  it("starts from the packaged menu and adopts a valid served menu", async () => {
    getWorkflowMenuDefinition.mockResolvedValue(SERVED_MENU);
    const { result } = renderHook(() => useWorkflowMenuDefinition());

    expect(result.current).toBe(DEFAULT_GENERATION_WORKFLOW_MENU);
    await waitFor(() => expect(result.current).toEqual(SERVED_MENU));
    expect(getWorkflowMenuDefinition).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
  });

  it("keeps the packaged menu when the served one is invalid or unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getWorkflowMenuDefinition.mockResolvedValue({ version: -1 });
    const { result } = renderHook(() => useWorkflowMenuDefinition());

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][0]).toBe(
      "[Generation] Falling back to the packaged workflow menu:",
    );
    expect(result.current).toBe(DEFAULT_GENERATION_WORKFLOW_MENU);
  });

  it("stays quiet when the request is aborted by unmount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getWorkflowMenuDefinition.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { unmount } = renderHook(() => useWorkflowMenuDefinition());
    const [signal] = getWorkflowMenuDefinition.mock.calls[0] as [AbortSignal];

    unmount();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
  });
});
