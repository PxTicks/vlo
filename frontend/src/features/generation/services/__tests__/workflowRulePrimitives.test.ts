import { describe, expect, it } from "vitest";
import type { WorkflowInput } from "../../types";
import { normalizeWorkflowRules } from "../workflowRules/normalize";
import {
  isWorkflowPipelineStageKind,
  workflowPipelineStageAffectsPreparedAssets,
} from "../workflowRules/pipelineCapabilities";
import {
  normalizeParamReference,
  toFiniteNumber,
  toPositiveInteger,
  toRulesWarning,
  toSelectionConfig,
  toStringRecord,
  toWidgetOptions,
  toWidgetValueType,
  toWorkflowInputType,
} from "../workflowRules/shared";
import {
  areInputConditionsSatisfied,
  findMissingRequiredWorkflowInputs,
  findUnsatisfiedInputConditions,
  findUnsatisfiedInputValidationRules,
  isWorkflowInputRequired,
  pruneRulesForSubmittedWorkflow,
} from "../workflowRules/validation";

function mediaInput(
  nodeId: string,
  inputType: WorkflowInput["inputType"] = "image",
): WorkflowInput {
  return {
    nodeId,
    classType: "LoadImage",
    inputType,
    param: "image",
    label: `Input ${nodeId}`,
    currentValue: null,
    origin: "inferred",
  };
}

describe("workflow rule primitives", () => {
  it("normalizes records, numbers, and warning payloads", () => {
    expect(toStringRecord({ value: 1 })).toEqual({ value: 1 });
    expect(toStringRecord(null)).toEqual({});
    expect(toStringRecord([])).toEqual({});
    expect(toRulesWarning("code", "message")).toEqual({
      code: "code",
      message: "message",
    });
    expect(toRulesWarning("code", "message", "12")).toEqual({
      code: "code",
      message: "message",
      node_id: "12",
    });
    expect(toPositiveInteger(2.6)).toBe(3);
    expect(toPositiveInteger(0)).toBeNull();
    expect(toPositiveInteger(Number.NaN)).toBeNull();
    expect(toFiniteNumber(3)).toBe(3);
    expect(toFiniteNumber(" 4.5 ")).toBe(4.5);
    expect(toFiniteNumber(" ")).toBeNull();
    expect(toFiniteNumber("no")).toBeNull();
    expect(toFiniteNumber({})).toBeNull();
  });

  it("normalizes parameter references and widget metadata", () => {
    expect(
      normalizeParamReference({ node_id: " 1 ", param: " seed " }),
    ).toEqual({ node_id: "1", param: "seed" });
    expect(normalizeParamReference(null)).toBeNull();
    expect(normalizeParamReference({ node_id: 1, param: "seed" })).toBeNull();
    expect(normalizeParamReference({ node_id: " ", param: "seed" })).toBeNull();
    expect(toWidgetValueType(" FLOAT ")).toBe("float");
    expect(toWidgetValueType("unsupported")).toBeUndefined();
    expect(toWidgetValueType(1)).toBeUndefined();
    expect(toWidgetOptions(["a", 1, true, null, {}])).toEqual([
      "a",
      1,
      true,
    ]);
    expect(toWidgetOptions([null, {}])).toBeUndefined();
    expect(toWidgetOptions("a")).toBeUndefined();
  });

  it.each([
    [" text ", "text"],
    ["IMAGE", "image"],
    ["audio", "audio"],
    ["video", "video"],
    ["mask", null],
  ])("normalizes workflow input type %s", (value, expected) => {
    expect(toWorkflowInputType(value)).toBe(expected);
  });

  it("builds only meaningful selection configuration", () => {
    expect(toSelectionConfig(undefined)).toBeUndefined();
    expect(toSelectionConfig({})).toBeUndefined();
    expect(
      toSelectionConfig({
        export_fps: 24,
        frame_step: 4,
        max_frames: 81,
        message: " Choose a range ",
        include_tracks: true,
      }),
    ).toEqual({
      exportFps: 24,
      frameStep: 4,
      maxFrames: 81,
      message: "Choose a range",
      includeTracks: true,
    });
    expect(
      toSelectionConfig({
        export_fps: 0,
        frame_step: -1,
        max_frames: 0,
        message: " ",
        include_tracks: false,
      }),
    ).toBeUndefined();
  });

  it("recognizes pipeline stages and their prepared-asset impact", () => {
    expect(isWorkflowPipelineStageKind("mask_processing")).toBe(true);
    expect(isWorkflowPipelineStageKind("aspect_ratio")).toBe(true);
    expect(isWorkflowPipelineStageKind("output_assembly")).toBe(true);
    expect(isWorkflowPipelineStageKind("unknown")).toBe(false);
    expect(isWorkflowPipelineStageKind(null)).toBe(false);
    expect(workflowPipelineStageAffectsPreparedAssets("mask_processing")).toBe(
      true,
    );
    expect(workflowPipelineStageAffectsPreparedAssets("output_assembly")).toBe(
      false,
    );
    expect(workflowPipelineStageAffectsPreparedAssets("unknown")).toBe(false);
  });

  it("normalizes missing, invalid, and valid rule objects", () => {
    expect(normalizeWorkflowRules(null).warnings).toEqual([]);
    expect(normalizeWorkflowRules("bad")).toMatchObject({
      warnings: [
        expect.objectContaining({ code: "invalid_workflow_rules" }),
      ],
    });
    expect(normalizeWorkflowRules([]).warnings).toHaveLength(1);
    expect(normalizeWorkflowRules({ version: 1 })).toMatchObject({
      rules: { version: 3 },
      warnings: [],
    });
  });

  it("prunes validation and conditions for nodes removed from a submitted workflow", () => {
    const rules = {
      version: 1,
      validation: {
        inputs: [
          { kind: "required", input: "1:image" },
          { kind: "optional", input: "9:image" },
          {
            kind: "at_least_n",
            inputs: ["1:image", "2:image", "9:image", ""],
            min: 3,
          },
          { kind: "at_least_n", inputs: ["9:image"], min: 1 },
        ],
      },
      input_conditions: [
        { kind: "at_least_one", inputs: ["1:image", "9:image"] },
        { kind: "at_least_one", inputs: ["9:image"] },
      ],
    };
    const submitted = {
      "1": { class_type: "LoadImage", inputs: {} },
      "2": { class_type: "LoadImage", inputs: {} },
    };

    expect(pruneRulesForSubmittedWorkflow(rules as never, submitted)).toEqual({
      ...rules,
      validation: {
        inputs: [
          { kind: "required", input: "1:image" },
          {
            kind: "at_least_n",
            inputs: ["1:image", "2:image"],
            min: 2,
          },
        ],
      },
      input_conditions: [
        { kind: "at_least_one", inputs: ["1:image"] },
      ],
    });
    expect(pruneRulesForSubmittedWorkflow(null, submitted)).toBeNull();
    expect(pruneRulesForSubmittedWorkflow(rules as never, null)).toBe(rules);
    expect(pruneRulesForSubmittedWorkflow(rules as never, {})).toBe(rules);
  });

  it("returns the original rules when every validation target survives", () => {
    const rules = {
      version: 1,
      validation: {
        inputs: [{ kind: "required", input: "1:image" }],
      },
      input_conditions: [
        { kind: "at_least_one", inputs: ["1:image"] },
      ],
    } as never;
    expect(
      pruneRulesForSubmittedWorkflow(rules, {
        "1": { class_type: "LoadImage", inputs: {} },
      }),
    ).toBe(rules);
  });

  it("builds default validation messages and applies workflow-input filtering", () => {
    const rules = {
      version: 1,
      validation: {
        inputs: [
          { kind: "required", input: "1:image" },
          { kind: "optional", input: "2:image" },
          {
            kind: "at_least_n",
            inputs: ["1:image", "2:image", "missing"],
            min: 2,
          },
          {
            kind: "at_least_n",
            inputs: ["missing"],
            min: 1,
          },
        ],
      },
    } as never;
    const inputs = [mediaInput("1"), mediaInput("2")];
    const failures = findUnsatisfiedInputValidationRules(
      rules,
      new Set(["2:image"]),
      inputs,
    );
    expect(failures).toEqual([
      {
        kind: "required",
        input: "1:image",
        message: "Input '1:image' is required.",
      },
      {
        kind: "at_least_n",
        inputs: ["1:image", "2:image"],
        min: 2,
        provided: 1,
        message:
          "Provide at least 2 of the following inputs: 1:image, 2:image",
      },
    ]);
  });

  it("falls back from legacy conditions and required media inputs", () => {
    const rules = {
      version: 1,
      nodes: {
        "2": { present: { required: false } },
      },
      input_conditions: [
        {
          kind: "at_least_one",
          inputs: ["1:image", "2:image"],
          message: "One image is needed",
        },
        { kind: "unsupported", inputs: ["3"] },
      ],
    } as never;
    expect(
      findUnsatisfiedInputValidationRules(rules, new Set()),
    ).toEqual([
      {
        kind: "at_least_n",
        inputs: ["1:image", "2:image"],
        min: 1,
        provided: 0,
        message: "One image is needed",
      },
      {
        kind: "at_least_n",
        inputs: ["3"],
        min: 1,
        provided: 0,
        message: "Provide at least one of the following inputs: 3",
      },
    ]);

    const inputs = [
      mediaInput("1"),
      mediaInput("2"),
      mediaInput("3", "text"),
    ];
    expect(findMissingRequiredWorkflowInputs(inputs, rules, new Set())).toEqual([
      {
        kind: "required",
        input: "1",
        message: "Input 1 is required.",
      },
    ]);
    expect(isWorkflowInputRequired(undefined, "1")).toBe(true);
  });

  it("evaluates supported legacy conditions only", () => {
    const rules = {
      version: 1,
      input_conditions: [
        { kind: "at_least_one", inputs: ["one", "two"] },
        { kind: "unsupported", inputs: ["three"] },
      ],
    } as never;
    expect(findUnsatisfiedInputConditions(undefined, new Set())).toEqual([]);
    expect(findUnsatisfiedInputConditions(rules, new Set())).toEqual([
      { kind: "at_least_one", inputs: ["one", "two"] },
    ]);
    expect(areInputConditionsSatisfied(rules, new Set(["two"]))).toBe(true);
  });
});
