import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGenerationStore } from "../useGenerationStore";
import type { WorkflowInput } from "../types";
import * as comfyApi from "../services/comfyuiApi";
import { createDefaultWorkflowRules } from "../services/workflowRules";

function makeInputs(): WorkflowInput[] {
  return [
    {
      nodeId: "1",
      classType: "LoadImage",
      inputType: "image",
      param: "image",
      label: "Image",
      currentValue: null,
      origin: "inferred",
    },
  ];
}

function makeConditioningInputs(): WorkflowInput[] {
  return [
    {
      nodeId: "4",
      classType: "CLIPTextEncode",
      inputType: "text",
      param: "text",
      label: "Prompt",
      currentValue: "avoid blur",
      origin: "inferred",
    },
    {
      nodeId: "3",
      classType: "CLIPTextEncode",
      inputType: "text",
      param: "text",
      label: "Prompt",
      currentValue: "a bright forest",
      origin: "inferred",
    },
  ];
}

function resetGenerationStore() {
  useGenerationStore.setState({
    availableWorkflows: [],
    tempWorkflow: null,
    selectedWorkflowId: null,
    syncedWorkflow: null,
    syncedGraphData: null,
    workflowInputs: [],
    workflowRuleWarnings: [],
    activeWorkflowRules: null,
    rulesWorkflowSourceId: null,
    activeRulesWarnings: [],
    derivedMaskMappings: [],
    mediaInputs: {},
    workflowWarning: null,
    hasInferredInputs: false,
    isWorkflowLoading: false,
    workflowLoadState: "idle",
    isWorkflowReady: false,
    editorRef: null,
    jobs: new Map(),
    activeJobId: null,
    maskCropMode: "crop",
  });
}

describe("useGenerationStore workflow editor sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetGenerationStore();
  });

  it("keeps a stable workflow id when syncing editor changes", async () => {
    useGenerationStore.setState({
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow" }],
      activeRulesWarnings: [],
      activeWorkflowRules: null,
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      { "1": { class_type: "LoadImage", inputs: { image: "input.png" } } },
      { nodes: [{ id: 1 }] },
      makeInputs(),
      null,
    );

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe("wf.json");
    expect(state.tempWorkflow).toBeNull();
    expect(state.availableWorkflows).toEqual([
      { id: "wf.json", name: "Workflow" },
    ]);
    expect(state.syncedGraphData).toEqual({ nodes: [{ id: 1 }] });
  });

  it("prefers the selected workflow id when ComfyUI exposes a temporary filename", async () => {
    useGenerationStore.setState({
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow" }],
      activeRulesWarnings: [],
      activeWorkflowRules: null,
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      { "1": { class_type: "LoadImage", inputs: { image: "input.png" } } },
      { nodes: [{ id: 2 }] },
      makeInputs(),
      "wf (1).json",
    );

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe("wf.json");
    expect(state.availableWorkflows).toEqual([
      { id: "wf.json", name: "Workflow" },
    ]);
    expect(state.syncedGraphData).toEqual({ nodes: [{ id: 2 }] });
  });

  it("normalizes bare editor filenames to .json when promoting persisted workflows", async () => {
    useGenerationStore.setState({
      selectedWorkflowId: null,
      availableWorkflows: [],
      activeRulesWarnings: [],
      activeWorkflowRules: null,
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      { "1": { class_type: "LoadImage", inputs: { image: "input.png" } } },
      { nodes: [{ id: 3 }] },
      makeInputs(),
      "wf",
    );

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe("wf.json");
    expect(state.availableWorkflows).toEqual([
      { id: "wf.json", name: "wf" },
    ]);
    expect(state.tempWorkflow).toBeNull();
  });

  it("loads workflow content from backend assets", async () => {
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({
      source: "backend",
    });
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      rules: createDefaultWorkflowRules(),
      warnings: [],
    });

    await useGenerationStore.getState().loadWorkflow("wf.json");

    expect(comfyApi.getWorkflowContent).toHaveBeenCalledWith("wf.json");
    expect(useGenerationStore.getState().syncedGraphData).toEqual({
      source: "backend",
    });
  });

  it("refreshes the selector from backend workflows only", async () => {
    vi.spyOn(comfyApi, "listWorkflows").mockResolvedValue([
      { id: "wf.json", name: "Workflow" },
    ]);
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({});
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      rules: createDefaultWorkflowRules(),
      warnings: [],
    });

    useGenerationStore.setState({
      availableWorkflows: [{ id: "local.json", name: "local" }],
      selectedWorkflowId: null,
    });

    await useGenerationStore.getState().fetchWorkflows();

    expect(useGenerationStore.getState().availableWorkflows).toEqual([
      { id: "wf.json", name: "Workflow" },
    ]);
  });

  it("applies conditioning labels and ordering when syncing editor changes", async () => {
    useGenerationStore.setState({
      selectedWorkflowId: "wf.json",
      availableWorkflows: [{ id: "wf.json", name: "Workflow" }],
      activeRulesWarnings: [],
      activeWorkflowRules: null,
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      {
        "2": { class_type: "CLIPLoader", inputs: {} },
        "3": {
          class_type: "CLIPTextEncode",
          inputs: { text: "a bright forest", clip: ["2", 0] },
        },
        "4": {
          class_type: "CLIPTextEncode",
          inputs: { text: "avoid blur", clip: ["2", 0] },
        },
        "9": {
          class_type: "KSampler",
          inputs: {
            positive: ["3", 0],
            negative: ["4", 0],
          },
        },
      },
      { nodes: [{ id: 3 }, { id: 4 }, { id: 9 }] },
      makeConditioningInputs(),
      null,
    );

    expect(useGenerationStore.getState().workflowInputs.map((input) => input.label)).toEqual([
      "Positive Prompt",
      "Negative Prompt",
    ]);
    expect(useGenerationStore.getState().workflowInputs.map((input) => input.nodeId)).toEqual([
      "3",
      "4",
    ]);
  });
});
