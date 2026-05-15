import { describe, expect, it } from "vitest";
import {
  buildWorkflowNodeSignature,
  buildWorkflowStructureSignature,
  haveMatchingWorkflowNodes,
} from "../workflowNodeSignature";

describe("workflowNodeSignature", () => {
  it("matches API and graph workflows by node ids and class types", () => {
    const apiWorkflow = {
      "1": {
        class_type: "LoadVideo",
        inputs: { file: "source-a.mp4" },
      },
      "2": {
        class_type: "VideoConsumer",
        inputs: { video: ["1", 0], strength: 0.7 },
      },
    };
    const graphWorkflow = {
      nodes: [
        {
          id: 1,
          type: "LoadVideo",
          title: "Video Loader",
          widgets_values: ["source-b.mp4"],
        },
        {
          id: 2,
          type: "VideoConsumer",
          widgets_values: [0.25],
        },
      ],
    };

    expect(haveMatchingWorkflowNodes(apiWorkflow, graphWorkflow)).toBe(true);
  });

  it("treats lowercase vlo memory-loader aliases as the same node class", () => {
    const apiWorkflow = {
      "129": {
        class_type: "VLOMemoryLoadVideo",
        inputs: { file: "source-a.mp4" },
      },
    };
    const graphWorkflow = {
      nodes: [
        {
          id: 129,
          type: "vloMemoryLoadVideo",
          widgets_values: ["source-b.mp4"],
        },
      ],
    };

    expect(haveMatchingWorkflowNodes(apiWorkflow, graphWorkflow)).toBe(true);
  });

  it("detects node-type mismatches", () => {
    const left = {
      "1": { class_type: "LoadVideo", inputs: {} },
      "2": { class_type: "VideoConsumer", inputs: {} },
    };
    const right = {
      "1": { class_type: "LoadVideo", inputs: {} },
      "2": { class_type: "ImageConsumer", inputs: {} },
    };

    expect(haveMatchingWorkflowNodes(left, right)).toBe(false);
  });

  it("includes subgraph nodes using parent-prefixed ids", () => {
    const apiWorkflow = {
      "10": { class_type: "MyComponent", inputs: {} },
      "10:1": { class_type: "InnerSource", inputs: {} },
      "10:2": { class_type: "InnerConsumer", inputs: { source: ["10:1", 0] } },
    };
    const graphWorkflow = {
      nodes: [{ id: 10, type: "MyComponent" }],
      definitions: {
        subgraphs: [
          {
            id: "MyComponent",
            nodes: [
              { id: 1, type: "InnerSource" },
              { id: 2, type: "InnerConsumer" },
            ],
          },
        ],
      },
    };

    expect(buildWorkflowNodeSignature(apiWorkflow)).toBe(
      buildWorkflowNodeSignature(graphWorkflow),
    );
  });

  it("captures wiring changes in the structure signature while ignoring literals", () => {
    const left = {
      "1": { class_type: "LoadVideo", inputs: { file: "a.mp4" } },
      "2": {
        class_type: "VideoConsumer",
        inputs: { video: ["1", 0], seed: 1 },
      },
    };
    const right = {
      "1": { class_type: "LoadVideo", inputs: { file: "b.mp4" } },
      "2": {
        class_type: "VideoConsumer",
        inputs: { video: ["1", 0], seed: 9999 },
      },
    };
    const rewired = {
      "1": { class_type: "LoadVideo", inputs: { file: "b.mp4" } },
      "2": {
        class_type: "VideoConsumer",
        inputs: { video: ["9", 0], seed: 9999 },
      },
    };

    expect(buildWorkflowStructureSignature(left)).toBe(
      buildWorkflowStructureSignature(right),
    );
    expect(buildWorkflowStructureSignature(left)).not.toBe(
      buildWorkflowStructureSignature(rewired),
    );
  });

  it("captures LiteGraph wiring changes while ignoring widget values", () => {
    const left = {
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          inputs: [],
          widgets_values: ["left.png"],
        },
        {
          id: 2,
          type: "ImageConsumer",
          inputs: [{ name: "image", link: 10 }],
          widgets_values: [123],
        },
      ],
      links: [[10, 1, 0, 2, 0, "IMAGE"]],
    };
    const right = {
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          inputs: [],
          widgets_values: ["right.png"],
        },
        {
          id: 2,
          type: "ImageConsumer",
          inputs: [{ name: "image", link: 10 }],
          widgets_values: [999],
        },
      ],
      links: [[10, 1, 0, 2, 0, "IMAGE"]],
    };
    const rewired = {
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          inputs: [],
          widgets_values: ["right.png"],
        },
        {
          id: 3,
          type: "LoadImage",
          inputs: [],
          widgets_values: ["other.png"],
        },
        {
          id: 2,
          type: "ImageConsumer",
          inputs: [{ name: "image", link: 11 }],
          widgets_values: [999],
        },
      ],
      links: [[11, 3, 0, 2, 0, "IMAGE"]],
    };

    expect(buildWorkflowStructureSignature(left)).toBe(
      buildWorkflowStructureSignature(right),
    );
    expect(buildWorkflowStructureSignature(left)).not.toBe(
      buildWorkflowStructureSignature(rewired),
    );
  });
});
