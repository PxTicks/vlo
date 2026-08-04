import { describe, expect, it } from "vitest";
import { flattenGraphNodes } from "../graphSubgraphs";

const INNER_SUBGRAPH_ID = "inner-subgraph-id";
const OUTER_SUBGRAPH_ID = "outer-subgraph-id";

/**
 * A subgraph whose first input is a plain IMAGE connection and whose second is
 * a promoted `noise_seed` widget. The IMAGE slot consumes no `widgets_values`
 * entry on the instance node, so the seed's value sits at index 0.
 */
function buildInnerDefinition() {
  return {
    id: INNER_SUBGRAPH_ID,
    name: "Sampler",
    inputNode: { id: -10 },
    inputs: [
      { id: "in-pixels", name: "pixels", type: "IMAGE", linkIds: [1] },
      { id: "in-seed", name: "noise_seed", type: "INT", linkIds: [2] },
    ],
    nodes: [
      {
        id: 4,
        type: "VAEEncode",
        inputs: [{ name: "pixels", type: "IMAGE", link: 1 }],
      },
      {
        id: 5,
        type: "RandomNoise",
        inputs: [
          {
            name: "noise_seed",
            type: "INT",
            widget: { name: "noise_seed" },
            link: 2,
          },
        ],
        widgets_values: [1, "randomize"],
      },
    ],
    links: [
      { id: 1, origin_id: -10, origin_slot: 0, target_id: 4, target_slot: 0 },
      { id: 2, origin_id: -10, origin_slot: 1, target_id: 5, target_slot: 0 },
    ],
  };
}

describe("flattenGraphNodes", () => {
  it("expands subgraph instances into instance-scoped execution ids", () => {
    const flattened = flattenGraphNodes({
      nodes: [{ id: 30, type: INNER_SUBGRAPH_ID, inputs: [] }],
      definitions: { subgraphs: [buildInnerDefinition()] },
    });

    expect(flattened.map((entry) => entry.nodeId)).toEqual(["30:4", "30:5"]);
    expect(flattened[1]).toMatchObject({
      classType: "RandomNoise",
      subgraphTitle: "Sampler",
    });
  });

  it("aligns promoted widget values with widget-backed input slots only", () => {
    const flattened = flattenGraphNodes({
      nodes: [
        { id: 20, type: "LoadImage", widgets_values: ["cat.png"] },
        {
          id: 30,
          type: INNER_SUBGRAPH_ID,
          inputs: [{ name: "pixels", type: "IMAGE", link: 77 }],
          // Only `noise_seed` is widget-backed, so it takes slot 0 even though
          // it is the definition's second input.
          widgets_values: [999],
        },
      ],
      links: [[77, 20, 0, 30, 0, "IMAGE"]],
      definitions: { subgraphs: [buildInnerDefinition()] },
    });

    const seedNode = flattened.find((entry) => entry.nodeId === "30:5");
    expect(seedNode?.promotedValues.get("noise_seed")).toBe(999);
    expect(seedNode?.linkedParams.has("noise_seed")).toBe(false);
  });

  it("resolves the boundary from definition links when linkIds went stale", () => {
    const definition = buildInnerDefinition();
    const flattened = flattenGraphNodes({
      nodes: [
        {
          id: 30,
          type: INNER_SUBGRAPH_ID,
          inputs: [],
          widgets_values: [999],
        },
      ],
      definitions: {
        subgraphs: [
          {
            ...definition,
            // Older/rewritten graphs can carry empty or stale linkIds while the
            // links themselves are intact.
            inputs: definition.inputs.map((slot) => ({ ...slot, linkIds: [] })),
          },
        ],
      },
    });

    const seedNode = flattened.find((entry) => entry.nodeId === "30:5");
    // The seed is a promoted widget, not an upstream connection.
    expect(seedNode?.linkedParams.has("noise_seed")).toBe(false);
    expect(seedNode?.promotedValues.get("noise_seed")).toBe(999);
  });

  it("treats inner inputs as linked when the instance slot is wired externally", () => {
    const flattened = flattenGraphNodes({
      nodes: [
        { id: 20, type: "LoadImage", widgets_values: ["cat.png"] },
        {
          id: 30,
          type: INNER_SUBGRAPH_ID,
          inputs: [{ name: "pixels", type: "IMAGE", link: 77 }],
          widgets_values: [999],
        },
      ],
      links: [[77, 20, 0, 30, 0, "IMAGE"]],
      definitions: { subgraphs: [buildInnerDefinition()] },
    });

    const encodeNode = flattened.find((entry) => entry.nodeId === "30:4");
    expect(encodeNode?.linkedParams.has("pixels")).toBe(true);
    expect(encodeNode?.promotedValues.size).toBe(0);
  });

  it("lets an outer instance's promoted value win over a nested instance's own", () => {
    const outerDefinition = {
      id: OUTER_SUBGRAPH_ID,
      name: "Wrapper",
      inputNode: { id: -10 },
      inputs: [
        { id: "out-seed", name: "noise_seed", type: "INT", linkIds: [11] },
      ],
      nodes: [
        {
          id: 30,
          type: INNER_SUBGRAPH_ID,
          inputs: [
            {
              name: "noise_seed",
              type: "INT",
              widget: { name: "noise_seed" },
              link: 11,
            },
          ],
          widgets_values: [999],
        },
      ],
      links: [
        { id: 11, origin_id: -10, origin_slot: 0, target_id: 30, target_slot: 0 },
      ],
    };

    const flattened = flattenGraphNodes({
      nodes: [{ id: 60, type: OUTER_SUBGRAPH_ID, inputs: [], widgets_values: [4242] }],
      definitions: {
        subgraphs: [buildInnerDefinition(), outerDefinition],
      },
    });

    const seedNode = flattened.find((entry) => entry.nodeId === "60:30:5");
    expect(seedNode?.promotedValues.get("noise_seed")).toBe(4242);
  });

  it("keeps muted nodes resolvable but does not expand muted instances", () => {
    const flattened = flattenGraphNodes({
      nodes: [{ id: 30, type: INNER_SUBGRAPH_ID, inputs: [], mode: 4 }],
      definitions: { subgraphs: [buildInnerDefinition()] },
    });

    expect(flattened).toHaveLength(1);
    expect(flattened[0]).toMatchObject({ nodeId: "30", muted: true });
  });

  it("stops expanding self-referential definitions", () => {
    const recursive = {
      id: "recursive-id",
      inputs: [],
      nodes: [{ id: 2, type: "recursive-id", inputs: [] }],
      links: [],
    };

    expect(
      flattenGraphNodes({
        nodes: [{ id: 1, type: "recursive-id", inputs: [] }],
        definitions: { subgraphs: [recursive] },
      }),
    ).toEqual([]);
  });
});
