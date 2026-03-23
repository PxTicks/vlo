import { describe, expect, it } from "vitest";
import {
  buildWorkflowNodeSignature,
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
});
