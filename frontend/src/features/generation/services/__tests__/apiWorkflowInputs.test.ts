import { describe, expect, it } from "vitest";
import { parseInputsFromApiWorkflow } from "../apiWorkflowInputs";

describe("apiWorkflowInputs", () => {
  it("falls back to VHS_LoadVideoFFmpeg as a discoverable video input", () => {
    const inputs = parseInputsFromApiWorkflow({
      "644": {
        class_type: "VHS_LoadVideoFFmpeg",
        inputs: {
          video: "source.mp4",
        },
        _meta: {
          title: "Source video",
        },
      },
    });

    expect(inputs).toEqual([
      {
        id: "644:video",
        nodeId: "644",
        classType: "VHS_LoadVideoFFmpeg",
        inputType: "video",
        param: "video",
        label: "Source video",
        description: null,
        currentValue: "source.mp4",
        origin: "inferred",
        dispatch: {
          kind: "node",
        },
      },
    ]);
  });

  it("falls back to VLOMemoryLoadVideo as a discoverable video input", () => {
    const inputs = parseInputsFromApiWorkflow({
      "145": {
        class_type: "VLOMemoryLoadVideo",
        inputs: {
          file: "memory-video-1",
        },
        _meta: {
          title: "Source video",
        },
      },
    });

    expect(inputs).toEqual([
      {
        id: "145:file",
        nodeId: "145",
        classType: "VLOMemoryLoadVideo",
        inputType: "video",
        param: "file",
        label: "Source video",
        description: null,
        currentValue: "memory-video-1",
        origin: "inferred",
        dispatch: {
          kind: "node",
        },
      },
    ]);
  });

  it("falls back to object_info display_name when an API workflow node has no title", () => {
    const inputs = parseInputsFromApiWorkflow(
      {
        "145": {
          class_type: "CheckpointLoaderSimple",
          inputs: {
            ckpt_name: "model.safetensors",
          },
        },
      },
      {
        CheckpointLoaderSimple: [
          {
            inputType: "image",
            param: "ckpt_name",
          },
        ],
      },
      {
        CheckpointLoaderSimple: {
          display_name: "Load Checkpoint",
        },
      },
    );

    expect(inputs).toEqual([
      {
        id: "145:ckpt_name",
        nodeId: "145",
        classType: "CheckpointLoaderSimple",
        inputType: "image",
        param: "ckpt_name",
        label: "Load Checkpoint",
        description: null,
        currentValue: "model.safetensors",
        origin: "inferred",
        dispatch: {
          kind: "node",
        },
      },
    ]);
  });
});
