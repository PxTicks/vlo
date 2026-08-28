import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelWorkPanel } from "../ModelWorkPanel";
import { useModelWorkStore } from "../../useModelWorkStore";
import type { ModelWorkEntry } from "../../services/modelWorkApi";

function entry(overrides: Partial<ModelWorkEntry>): ModelWorkEntry {
  return {
    entryId: "entry-1",
    resource: "local-gpu",
    tenant: "comfyui-process",
    source: "comfyui-vlo",
    owner: "vlo.comfyui",
    label: "Flux render",
    jobStatus: "running",
    occupancy: "occupied",
    progress: null,
    message: null,
    submittedAt: 1,
    startedAt: 1,
    endedAt: null,
    parentOccupancyId: "occ-1",
    cancelEndpoint: null,
    promptId: "prompt-1",
    suspectedStale: false,
    ...overrides,
  };
}

afterEach(() => {
  // Unmount before resetting: the panel subscribes to the store, so clearing
  // it under a live tree is a React update outside act().
  cleanup();
  act(() => {
    useModelWorkStore.setState({ entries: [], resources: [] });
  });
});

describe("ModelWorkPanel", () => {
  it("separates the executing prompt from its submitted-ahead siblings", () => {
    // A batch handed to ComfyUI up front shares one `comfyui-process`
    // occupancy, so occupancy alone would render every prompt as running on a
    // card that runs one at a time.
    useModelWorkStore.setState({
      ready: true,
      entries: [
        entry({ entryId: "a", label: "Running one", jobStatus: "running" }),
        entry({ entryId: "b", label: "Queued one", jobStatus: "queued" }),
        entry({ entryId: "c", label: "Queued two", jobStatus: "queued" }),
      ],
      resources: [],
    });

    render(<ModelWorkPanel />);

    expect(screen.getAllByText("Queued")).toHaveLength(2);
    expect(screen.getAllByText("Running")).toHaveLength(1);
  });

  it("shows a progress bar only for the prompt that is actually executing", () => {
    useModelWorkStore.setState({
      ready: true,
      entries: [
        entry({ entryId: "a", jobStatus: "running", progress: 0.5 }),
        entry({ entryId: "b", jobStatus: "queued" }),
      ],
      resources: [],
    });

    const { container } = render(<ModelWorkPanel />);

    expect(container.querySelectorAll(".MuiLinearProgress-root")).toHaveLength(1);
  });
});
