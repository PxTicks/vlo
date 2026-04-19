import { beforeEach, describe, expect, it, vi } from "vitest";

import { TEMP_WORKFLOW_ID, useGenerationStore } from "../useGenerationStore";
import type { WorkflowInput } from "../types";
import * as comfyApi from "../services/comfyuiApi";
import * as workflowSyncController from "../services/workflowSyncController";
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
    vi.spyOn(comfyApi, "resolveWorkflowRules").mockResolvedValue({
      workflow_id: "",
      rules: createDefaultWorkflowRules(),
      warnings: [],
    });
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

  it("preserves workflow group metadata when syncing editor changes", async () => {
    useGenerationStore.setState({
      selectedWorkflowId: "wf.json",
      availableWorkflows: [
        {
          id: "wf.json",
          name: "Workflow",
          groupId: "core",
          groupName: "Core",
          groupOrder: 1,
        },
      ],
      activeRulesWarnings: [],
      activeWorkflowRules: null,
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      { "1": { class_type: "LoadImage", inputs: { image: "input.png" } } },
      { nodes: [{ id: 1 }] },
      makeInputs(),
      null,
    );

    expect(useGenerationStore.getState().availableWorkflows).toEqual([
      {
        id: "wf.json",
        name: "Workflow",
        groupId: "core",
        groupName: "Core",
        groupOrder: 1,
      },
    ]);
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

  it("keeps replay-derived temp workflows attached to their source rules when the iframe reports a synthetic temp filename", async () => {
    useGenerationStore.setState({
      selectedWorkflowId: TEMP_WORKFLOW_ID,
      availableWorkflows: [{ id: TEMP_WORKFLOW_ID, name: "Edited Workflow" }],
      activeRulesWarnings: [],
      activeWorkflowRules: createDefaultWorkflowRules(),
      rulesWorkflowSourceId: "wan2_2_flf2v.json",
      tempWorkflow: {
        workflow: { "1": { class_type: "LoadImage", inputs: {} } },
        graphData: { nodes: [{ id: 1 }] },
        inputs: makeInputs(),
        rules: createDefaultWorkflowRules(),
        rulesSourceId: "wan2_2_flf2v.json",
        rulesWarnings: [],
      },
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      { "1": { class_type: "LoadImage", inputs: { image: "input.png" } } },
      { nodes: [{ id: 4 }] },
      makeInputs(),
      "__temp__.json",
    );

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe(TEMP_WORKFLOW_ID);
    expect(state.rulesWorkflowSourceId).toBe("wan2_2_flf2v.json");
    expect(state.tempWorkflow?.rulesSourceId).toBe("wan2_2_flf2v.json");
    expect(state.availableWorkflows).toEqual([
      { id: TEMP_WORKFLOW_ID, name: "Edited Workflow" },
    ]);
    expect(state.syncedGraphData).toEqual({ nodes: [{ id: 4 }] });
  });

  it("refreshes live widget rules from the current editor workflow graph", async () => {
    vi.spyOn(comfyApi, "resolveWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      rules: createDefaultWorkflowRules({
        nodes: {
          "4814": {
            widgets: {
              noise_seed: {
                label: "noise_seed",
                control_after_generate: true,
                default_randomize: true,
                value_type: "int",
                min: 0,
                max: 99,
              },
            },
          },
        },
      }),
      warnings: [],
    });

    useGenerationStore.setState({
      selectedWorkflowId: TEMP_WORKFLOW_ID,
      availableWorkflows: [{ id: TEMP_WORKFLOW_ID, name: "Edited Workflow" }],
      activeRulesWarnings: [],
      activeWorkflowRules: createDefaultWorkflowRules(),
      rulesWorkflowSourceId: "wf.json",
      tempWorkflow: {
        workflow: { "1": { class_type: "LoadImage", inputs: {} } },
        graphData: { nodes: [{ id: 1 }] },
        inputs: makeInputs(),
        rules: createDefaultWorkflowRules(),
        rulesSourceId: "wf.json",
        rulesWarnings: [],
      },
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      { "4814": { class_type: "RandomNoise", inputs: { noise_seed: 42 } } },
      {
        nodes: [
          {
            id: 4814,
            type: "RandomNoise",
            widgets_values: [42, "randomize"],
          },
        ],
      },
      [],
      "__temp__.json",
    );

    expect(comfyApi.resolveWorkflowRules).toHaveBeenCalledWith({
      workflow: {
        "4814": { class_type: "RandomNoise", inputs: { noise_seed: 42 } },
      },
      graphData: {
        nodes: [
          {
            id: 4814,
            type: "RandomNoise",
            widgets_values: [42, "randomize"],
          },
        ],
      },
      workflowId: "wf.json",
    });
    expect(
      useGenerationStore.getState().activeWorkflowRules?.nodes?.["4814"]?.widgets
        ?.noise_seed?.default_randomize,
    ).toBe(true);
  });

  it("keeps source rules when a bypassed editor node is omitted from the api workflow", async () => {
    vi.spyOn(comfyApi, "resolveWorkflowRules").mockResolvedValue({
      workflow_id: "wan2_2_flf2v.json",
      rules: createDefaultWorkflowRules({
        nodes: {
          "72": {
            widgets: {
              strength_model: {
                label: "Strength",
                value_type: "float",
              },
            },
          },
        },
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            config: {
              resolutions: [480, 720],
            },
            targets: [
              {
                width: {
                  node_id: "67",
                  param: "width",
                },
                height: {
                  node_id: "67",
                  param: "height",
                },
              },
            ],
          },
        ],
      }),
      warnings: [],
    });

    useGenerationStore.setState({
      selectedWorkflowId: "wan2_2_flf2v.json",
      availableWorkflows: [
        { id: "wan2_2_flf2v.json", name: "Wan2.2 I2V & FLF2V" },
      ],
      activeRulesWarnings: [],
      activeWorkflowRules: createDefaultWorkflowRules({
        nodes: {
          "72": {
            widgets: {
              strength_model: {
                label: "Strength",
              },
            },
          },
        },
        pipeline: [
          {
            id: "aspect_ratio",
            kind: "aspect_ratio",
            config: {
              resolutions: [480, 720],
            },
            targets: [
              {
                width: {
                  node_id: "67",
                  param: "width",
                },
                height: {
                  node_id: "67",
                  param: "height",
                },
              },
            ],
          },
        ],
      }),
      rulesWorkflowSourceId: "wan2_2_flf2v.json",
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      {
        "62": { class_type: "LoadImage", inputs: { image: "start.png" } },
        "67": { class_type: "WanFirstLastFrameToVideo", inputs: {} },
        "68": { class_type: "LoadImage", inputs: { image: "end.png" } },
      },
      {
        nodes: [
          { id: 62, type: "LoadImage" },
          { id: 67, type: "WanFirstLastFrameToVideo" },
          { id: 68, type: "LoadImage" },
          { id: 72, type: "LoraLoader", mode: 4 },
        ],
      },
      makeInputs(),
      "__temp__.json",
    );

    const state = useGenerationStore.getState();
    expect(comfyApi.resolveWorkflowRules).toHaveBeenCalledWith({
      workflow: {
        "62": { class_type: "LoadImage", inputs: { image: "start.png" } },
        "67": { class_type: "WanFirstLastFrameToVideo", inputs: {} },
        "68": { class_type: "LoadImage", inputs: { image: "end.png" } },
      },
      graphData: {
        nodes: [
          { id: 62, type: "LoadImage" },
          { id: 67, type: "WanFirstLastFrameToVideo" },
          { id: 68, type: "LoadImage" },
          { id: 72, type: "LoraLoader", mode: 4 },
        ],
      },
      workflowId: "wan2_2_flf2v.json",
    });
    expect(state.selectedWorkflowId).toBe("wan2_2_flf2v.json");
    expect(state.rulesWorkflowSourceId).toBe("wan2_2_flf2v.json");
    expect(state.activeWorkflowRules?.pipeline?.[0]?.kind).toBe("aspect_ratio");
    expect(state.activeWorkflowRules?.pipeline?.[0]?.targets).toEqual([
      {
        width: {
          node_id: "67",
          param: "width",
        },
        height: {
          node_id: "67",
          param: "height",
        },
      },
    ]);
  });

  it("keeps derived mask sidecar rules when the visual editor graph omits a node but the api workflow still includes it", async () => {
    vi.spyOn(comfyApi, "resolveWorkflowRules").mockImplementation(
      async ({ workflowId }) => ({
        workflow_id: workflowId ?? "",
        rules:
          workflowId === "vlo_VACE_inpaint.json"
            ? createDefaultWorkflowRules({
                pipeline: [
                  {
                    id: "mask_processing",
                    kind: "mask_processing",
                    targets: [
                      {
                        source: { node_id: "98", param: "video" },
                        mask: { node_id: "101", param: "video" },
                        mask_type: "binary",
                        purpose: "video",
                      },
                    ],
                  },
                ],
              })
            : createDefaultWorkflowRules(),
        warnings: [],
      }),
    );

    useGenerationStore.setState({
      selectedWorkflowId: "vlo_VACE_inpaint.json",
      availableWorkflows: [
        { id: "vlo_VACE_inpaint.json", name: "VACE Inpaint" },
      ],
      activeRulesWarnings: [],
      activeWorkflowRules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            targets: [
              {
                source: { node_id: "98", param: "video" },
                mask: { node_id: "101", param: "video" },
                mask_type: "binary",
                purpose: "video",
              },
            ],
          },
        ],
      }),
      rulesWorkflowSourceId: "vlo_VACE_inpaint.json",
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      {
        "98": { class_type: "LoadVideo", inputs: { video: "source.mov" } },
        "101": { class_type: "LoadVideo", inputs: { video: "mask.mov" } },
      },
      {
        nodes: [{ id: 98, type: "LoadVideo" }],
      },
      [
        {
          nodeId: "98",
          classType: "LoadVideo",
          inputType: "video",
          param: "video",
          label: "Video",
          currentValue: null,
          origin: "inferred",
        },
        {
          nodeId: "101",
          classType: "LoadVideo",
          inputType: "video",
          param: "video",
          label: "Mask Video",
          currentValue: null,
          origin: "inferred",
        },
      ],
      "__temp__.json",
    );

    expect(comfyApi.resolveWorkflowRules).toHaveBeenCalledWith({
      workflow: {
        "98": { class_type: "LoadVideo", inputs: { video: "source.mov" } },
        "101": { class_type: "LoadVideo", inputs: { video: "mask.mov" } },
      },
      graphData: {
        nodes: [{ id: 98, type: "LoadVideo" }],
      },
      workflowId: "vlo_VACE_inpaint.json",
    });

    const state = useGenerationStore.getState();
    expect(state.rulesWorkflowSourceId).toBe("vlo_VACE_inpaint.json");
    expect(state.workflowInputs.map((input) => input.nodeId)).toEqual(["98"]);
    expect(state.derivedMaskMappings).toMatchObject([
      {
        maskNodeId: "101",
        maskParam: "video",
        sourceNodeId: "98",
        sourceInputId: "98:video",
        maskType: "binary",
        purpose: "video",
      },
    ]);
  });

  it("maps binary_audio_derived_mask_of rules into hidden audio-timing mask inputs", async () => {
    vi.spyOn(comfyApi, "resolveWorkflowRules").mockResolvedValue({
      workflow_id: "ltx.json",
      rules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            targets: [
              {
                source: { node_id: "98", param: "video" },
                mask: { node_id: "202", param: "video" },
                mask_type: "binary",
                purpose: "audio_timing",
                render_fps: 17,
              },
            ],
          },
        ],
      }),
      warnings: [],
    });

    useGenerationStore.setState({
      selectedWorkflowId: "ltx.json",
      availableWorkflows: [{ id: "ltx.json", name: "LTX" }],
      activeRulesWarnings: [],
      activeWorkflowRules: createDefaultWorkflowRules({
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            targets: [
              {
                source: { node_id: "98", param: "video" },
                mask: { node_id: "202", param: "video" },
                mask_type: "binary",
                purpose: "audio_timing",
                render_fps: 17,
              },
            ],
          },
        ],
      }),
      rulesWorkflowSourceId: "ltx.json",
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      {
        "98": { class_type: "LoadVideo", inputs: { video: "source.mov" } },
        "202": { class_type: "LoadVideo", inputs: { video: "audio-mask.mov" } },
      },
      {
        nodes: [{ id: 98, type: "LoadVideo" }],
      },
      [
        {
          nodeId: "98",
          classType: "LoadVideo",
          inputType: "video",
          param: "video",
          label: "Video",
          currentValue: null,
          origin: "inferred",
        },
        {
          nodeId: "202",
          classType: "LoadVideo",
          inputType: "video",
          param: "video",
          label: "Audio Mask Video",
          currentValue: null,
          origin: "inferred",
        },
      ],
      "__temp__.json",
    );

    const state = useGenerationStore.getState();
    expect(state.workflowInputs.map((input) => input.nodeId)).toEqual(["98"]);
    expect(state.derivedMaskMappings).toEqual([
      {
        maskNodeId: "202",
        maskParam: "video",
        sourceNodeId: "98",
        sourceInputId: "98:video",
        maskType: "binary",
        purpose: "audio_timing",
        renderFps: 17,
      },
    ]);
  });

  it("keeps applicable retake mask rules when unrelated sidecar nodes are missing from the edited prompt", async () => {
    vi.spyOn(comfyApi, "resolveWorkflowRules").mockResolvedValue({
      workflow_id: "video_ltx2_3_retake.json",
      rules: createDefaultWorkflowRules({
        nodes: {
          "115": {
            widgets: {
              noise_seed: {
                label: "Noise seed",
                value_type: "int",
              },
            },
          },
          "644": {
            present: {
              label: "Source video",
              input_type: "video",
              param: "video",
              class_type: "VHS_LoadVideoFFmpeg",
            },
          },
          "705": {
            widgets: {
              switch: {
                label: "Bypass video retake",
                value_type: "boolean",
              },
            },
          },
          "714": {
            widgets: {
              switch: {
                label: "Bypass audio retake",
                value_type: "boolean",
              },
            },
          },
        },
        derived_widgets: [
          {
            id: "retake_mode",
            kind: "video_audio_retake",
            video_bypass: {
              node_id: "705",
              param: "switch",
            },
            audio_bypass: {
              node_id: "714",
              param: "switch",
            },
          },
        ],
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            targets: [
              {
                source: { node_id: "644", param: "video" },
                mask: { node_id: "689", param: "file" },
                mask_type: "binary",
                purpose: "video",
              },
              {
                source: { node_id: "644", param: "video" },
                mask: { node_id: "691", param: "file" },
                mask_type: "binary",
                purpose: "audio_timing",
                render_fps: 25,
              },
            ],
          },
        ],
      }),
      warnings: [],
    });

    useGenerationStore.setState({
      selectedWorkflowId: "video_ltx2_3_retake.json",
      availableWorkflows: [
        { id: "video_ltx2_3_retake.json", name: "LTX2.3 ReTake" },
      ],
      activeRulesWarnings: [],
      activeWorkflowRules: createDefaultWorkflowRules({
        nodes: {
          "115": {
            widgets: {
              noise_seed: {
                label: "Noise seed",
                value_type: "int",
              },
            },
          },
          "644": {
            present: {
              label: "Source video",
              input_type: "video",
              param: "video",
              class_type: "VHS_LoadVideoFFmpeg",
            },
          },
          "705": {
            widgets: {
              switch: {
                label: "Bypass video retake",
                value_type: "boolean",
              },
            },
          },
          "714": {
            widgets: {
              switch: {
                label: "Bypass audio retake",
                value_type: "boolean",
              },
            },
          },
        },
        derived_widgets: [
          {
            id: "retake_mode",
            kind: "video_audio_retake",
            video_bypass: {
              node_id: "705",
              param: "switch",
            },
            audio_bypass: {
              node_id: "714",
              param: "switch",
            },
          },
        ],
        pipeline: [
          {
            id: "mask_processing",
            kind: "mask_processing",
            targets: [
              {
                source: { node_id: "644", param: "video" },
                mask: { node_id: "689", param: "file" },
                mask_type: "binary",
                purpose: "video",
              },
              {
                source: { node_id: "644", param: "video" },
                mask: { node_id: "691", param: "file" },
                mask_type: "binary",
                purpose: "audio_timing",
                render_fps: 25,
              },
            ],
          },
        ],
      }),
      rulesWorkflowSourceId: "video_ltx2_3_retake.json",
      syncedWorkflow: {
        "115": { class_type: "RandomNoise", inputs: { noise_seed: 1 } },
        "644": { class_type: "VHS_LoadVideoFFmpeg", inputs: { video: "source.mov" } },
        "689": { class_type: "VHS_LoadVideoFFmpeg", inputs: { file: "mask.mov" } },
        "691": {
          class_type: "VHS_LoadVideoFFmpeg",
          inputs: { file: "audio-mask.mov" },
        },
        "705": { class_type: "BypassToggle", inputs: { switch: false } },
        "714": { class_type: "BypassToggle", inputs: { switch: false } },
      },
      syncedGraphData: {
        nodes: [
          { id: 115, type: "RandomNoise" },
          { id: 644, type: "VHS_LoadVideoFFmpeg" },
          { id: 689, type: "VHS_LoadVideoFFmpeg" },
          { id: 691, type: "VHS_LoadVideoFFmpeg" },
          { id: 705, type: "BypassToggle" },
          { id: 714, type: "BypassToggle" },
          { id: 578, type: "SaveImageWebsocket" },
          { id: 715, type: "PreviewAudio" },
        ],
      },
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      {
        "644": { class_type: "VHS_LoadVideoFFmpeg", inputs: { video: "source.mov" } },
        "689": { class_type: "VHS_LoadVideoFFmpeg", inputs: { file: "mask.mov" } },
        "691": {
          class_type: "VHS_LoadVideoFFmpeg",
          inputs: { file: "audio-mask.mov" },
        },
        "705": { class_type: "BypassToggle", inputs: { switch: false } },
        "714": { class_type: "BypassToggle", inputs: { switch: false } },
        "900": { class_type: "SomeNewNode", inputs: {} },
      },
      {
        nodes: [
          { id: 644, type: "VHS_LoadVideoFFmpeg" },
          { id: 689, type: "VHS_LoadVideoFFmpeg" },
          { id: 691, type: "VHS_LoadVideoFFmpeg" },
          { id: 705, type: "BypassToggle" },
          { id: 714, type: "BypassToggle" },
          { id: 900, type: "SomeNewNode" },
        ],
      },
      [
        {
          nodeId: "644",
          classType: "VHS_LoadVideoFFmpeg",
          inputType: "video",
          param: "video",
          label: "Source video",
          currentValue: null,
          origin: "inferred",
        },
        {
          nodeId: "689",
          classType: "VHS_LoadVideoFFmpeg",
          inputType: "video",
          param: "file",
          label: "Mask video",
          currentValue: null,
          origin: "inferred",
        },
        {
          nodeId: "691",
          classType: "VHS_LoadVideoFFmpeg",
          inputType: "video",
          param: "file",
          label: "Audio mask video",
          currentValue: null,
          origin: "inferred",
        },
      ],
      "__temp__.json",
    );

    expect(comfyApi.resolveWorkflowRules).toHaveBeenCalledWith({
      workflow: {
        "644": { class_type: "VHS_LoadVideoFFmpeg", inputs: { video: "source.mov" } },
        "689": { class_type: "VHS_LoadVideoFFmpeg", inputs: { file: "mask.mov" } },
        "691": {
          class_type: "VHS_LoadVideoFFmpeg",
          inputs: { file: "audio-mask.mov" },
        },
        "705": { class_type: "BypassToggle", inputs: { switch: false } },
        "714": { class_type: "BypassToggle", inputs: { switch: false } },
        "900": { class_type: "SomeNewNode", inputs: {} },
      },
      graphData: {
        nodes: [
          { id: 644, type: "VHS_LoadVideoFFmpeg" },
          { id: 689, type: "VHS_LoadVideoFFmpeg" },
          { id: 691, type: "VHS_LoadVideoFFmpeg" },
          { id: 705, type: "BypassToggle" },
          { id: 714, type: "BypassToggle" },
          { id: 900, type: "SomeNewNode" },
        ],
      },
      workflowId: "video_ltx2_3_retake.json",
    });

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe("video_ltx2_3_retake.json");
    expect(state.rulesWorkflowSourceId).toBe("video_ltx2_3_retake.json");
    expect(state.workflowInputs.map((input) => input.nodeId)).toEqual(["644"]);
    expect(state.derivedMaskMappings).toEqual([
      {
        maskNodeId: "689",
        maskParam: "file",
        sourceNodeId: "644",
        sourceInputId: "644:video",
        maskType: "binary",
        purpose: "video",
      },
      {
        maskNodeId: "691",
        maskParam: "file",
        sourceNodeId: "644",
        sourceInputId: "644:video",
        maskType: "binary",
        purpose: "audio_timing",
        renderFps: 25,
      },
    ]);
    expect(state.activeWorkflowRules?.nodes?.["115"]).toBeUndefined();
  });

  it("drops incompatible persisted rules when a different workflow is loaded into the editor tab", async () => {
    useGenerationStore.setState({
      selectedWorkflowId: "video_ltx2_3_i2v.json",
      availableWorkflows: [
        { id: "video_ltx2_3_i2v.json", name: "LTX I2V" },
      ],
      activeRulesWarnings: [],
      activeWorkflowRules: createDefaultWorkflowRules({
        nodes: {
          "267": {
            widgets: {
              cfg: {
                label: "CFG",
              },
            },
          },
        },
      }),
      rulesWorkflowSourceId: "video_ltx2_3_i2v.json",
    });

    await useGenerationStore.getState().registerWorkflowFromEditor(
      { "2004": { class_type: "LoadImage", inputs: { image: "input.png" } } },
      { nodes: [{ id: 2004, type: "LoadImage" }] },
      [
        {
          nodeId: "2004",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Image",
          currentValue: null,
          origin: "inferred",
        },
      ],
      "video_ltx2_3_i2v.json",
    );

    const state = useGenerationStore.getState();
    expect(state.selectedWorkflowId).toBe(TEMP_WORKFLOW_ID);
    expect(state.rulesWorkflowSourceId).toBeNull();
    expect(state.activeWorkflowRules?.nodes).toEqual({});
    expect(state.tempWorkflow?.rulesSourceId).toBeNull();
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

  it("does not leave the previous workflow marked ready when a new sync fails", async () => {
    vi.spyOn(comfyApi, "getWorkflowContent").mockResolvedValue({
      source: "backend",
    });
    vi.spyOn(comfyApi, "getWorkflowRules").mockResolvedValue({
      workflow_id: "wf.json",
      rules: createDefaultWorkflowRules(),
      warnings: [],
    });
    vi.spyOn(workflowSyncController, "injectWorkflowAndRead").mockResolvedValue({
      ok: false,
      deferred: false,
      workflowResult: null,
      reason: "sync failed",
      warnings: null,
    });

    useGenerationStore.setState({
      syncedWorkflow: { old: true },
      syncedGraphData: { old: true },
      workflowInputs: makeInputs(),
      editorRef: {} as HTMLIFrameElement,
    });

    await useGenerationStore.getState().loadWorkflow("wf.json");

    const state = useGenerationStore.getState();
    expect(state.syncedWorkflow).toBeNull();
    expect(state.isWorkflowReady).toBe(false);
    expect(state.workflowLoadState).toBe("error");
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

  it("carries a single media input across a workflow switch after sync", () => {
    useGenerationStore.setState({
      workflowInputs: [
        {
          nodeId: "10",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Image",
          currentValue: null,
          origin: "rule",
        },
      ],
      mediaInputs: {
        "10:image": {
          kind: "asset",
          asset: {
            id: "asset-1",
            hash: "hash-1",
            name: "frame.png",
            type: "video",
            src: "assets/frame.png",
            createdAt: Date.now(),
          },
        },
      },
      activeRulesWarnings: [],
      activeWorkflowRules: null,
    });

    useGenerationStore.getState().syncWorkflow(
      { "20": { class_type: "LoadImage", inputs: { image: "frame.png" } } },
      { nodes: [{ id: 20 }] },
      [
        {
          nodeId: "20",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Reference Image",
          currentValue: null,
          origin: "rule",
        },
      ],
    );

    expect(useGenerationStore.getState().mediaInputs).toEqual({
      "20:image": {
        kind: "asset",
        asset: {
          id: "asset-1",
          hash: "hash-1",
          name: "frame.png",
          type: "video",
          src: "assets/frame.png",
          createdAt: expect.any(Number),
        },
      },
    });
  });
});
