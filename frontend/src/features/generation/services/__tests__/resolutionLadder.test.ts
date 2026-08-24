import { describe, expect, it } from "vitest";

import {
  createDefaultWorkflowRules,
  getSupportedWorkflowResolutions,
  getWorkflowResolutionLadder,
  interpolateResolutionLadder,
  normalizeCustomResolution,
  MAX_CUSTOM_RESOLUTION,
  MAX_RESOLUTION_LADDER_STEPS,
} from "../workflowRules";
import { resolvePipelineWidgetInputs } from "../workflowRules/pipelineWidgets";
import { checkWidgetValue } from "../generationSessionValidation";

function rulesWithAspectRatioConfig(
  config: Record<string, unknown>,
  controls: Array<Record<string, unknown>> = [
    { key: "target_resolution", label: "Resolution", value_type: "int" },
  ],
) {
  return createDefaultWorkflowRules({
    pipeline: [
      {
        id: "aspect_ratio",
        kind: "aspect_ratio",
        config,
        targets: [
          {
            width: { node_id: "1", param: "width" },
            height: { node_id: "1", param: "height" },
          },
        ],
        controls,
      },
    ],
  } as never);
}

const WIDGET_OPTIONS = {
  showTargetResolution: true,
  currentResolution: 720,
  showAspectRatioSelector: true,
  aspectRatioSelection: "auto",
  projectAspectRatio: "16:9",
  showMaskControls: false,
  maskCropMode: "crop" as const,
  maskCropDilation: 0.1,
} as const;

describe("interpolateResolutionLadder", () => {
  it("interpolates evenly between the bounds", () => {
    expect(
      interpolateResolutionLadder({ min: 240, max: 720, steps: 5 }),
    ).toEqual([240, 360, 480, 600, 720]);
  });

  it("keeps the authored endpoints exact and rounds the interior to even", () => {
    // 240..725 in 3 steps puts the interior rung on 482.5.
    expect(
      interpolateResolutionLadder({ min: 240, max: 725, steps: 3 }),
    ).toEqual([240, 482, 725]);
  });

  it("collapses rungs a narrow range cannot keep distinct", () => {
    expect(interpolateResolutionLadder({ min: 240, max: 242, steps: 5 })).toEqual(
      [240, 242],
    );
  });

  it("never returns fewer than the two endpoints", () => {
    expect(interpolateResolutionLadder({ min: 480, max: 720, steps: 1 })).toEqual(
      [480, 720],
    );
  });

  it("bounds the number of rungs from unvalidated rules", () => {
    expect(
      interpolateResolutionLadder({ min: 1, max: 100, steps: 10_000 }),
    ).toHaveLength(MAX_RESOLUTION_LADDER_STEPS);
  });
});

describe("getWorkflowResolutionLadder", () => {
  it("interpolates a declared ladder", () => {
    const rules = rulesWithAspectRatioConfig({
      resolution_ladder: { min: 240, max: 720, steps: 5 },
    });

    expect(getWorkflowResolutionLadder(rules)).toEqual({
      values: [240, 360, 480, 600, 720],
      ladder: { min: 240, max: 720, steps: 5 },
    });
    // A ladder is presentation only, so nothing clamps at dispatch.
    expect(getSupportedWorkflowResolutions(rules)).toEqual([]);
  });

  it("presents a legacy whitelist as its own rungs without a range", () => {
    const rules = rulesWithAspectRatioConfig({ resolutions: [720, 480] });

    expect(getWorkflowResolutionLadder(rules)).toEqual({
      values: [480, 720],
      ladder: null,
    });
  });

  it("falls back to the default ladder when a stage configures neither", () => {
    expect(getWorkflowResolutionLadder(rulesWithAspectRatioConfig({}))).toEqual({
      values: [240, 360, 480, 600, 720],
      ladder: { min: 240, max: 720, steps: 5 },
    });
  });

  it("returns nothing when there is no aspect ratio stage", () => {
    expect(getWorkflowResolutionLadder(createDefaultWorkflowRules())).toBeNull();
  });
});

describe("normalizeCustomResolution", () => {
  it("accepts arbitrary positive short edges", () => {
    expect(normalizeCustomResolution(837)).toBe(837);
    expect(normalizeCustomResolution("1080")).toBe(1080);
  });

  it("rejects nonsense and caps absurd values", () => {
    expect(normalizeCustomResolution(0)).toBeNull();
    expect(normalizeCustomResolution(-720)).toBeNull();
    expect(normalizeCustomResolution("abc")).toBeNull();
    expect(normalizeCustomResolution(10_000)).toBe(MAX_CUSTOM_RESOLUTION);
  });
});

describe("resolvePipelineWidgetInputs aspect ratio controls", () => {
  it("gives a declared ladder a stepped resolution control", () => {
    const widgets = resolvePipelineWidgetInputs(
      rulesWithAspectRatioConfig({
        resolution_ladder: { min: 240, max: 720, steps: 5 },
      }),
      WIDGET_OPTIONS,
    );

    const resolution = widgets.find(
      (widget) => widget.param === "target_resolution",
    );
    expect(resolution?.config.resolutionLadder).toEqual([
      240, 360, 480, 600, 720,
    ]);
    expect(resolution?.config.options).toBeUndefined();
    expect(resolution?.config.valueType).toBe("int");
    // No bounds: the session validates writes against min/max, and a custom
    // override has to be able to leave the ladder's range.
    expect(resolution?.config.min).toBeUndefined();
    expect(resolution?.config.max).toBeUndefined();
  });

  it("leaves a legacy whitelist as an enumerated dropdown", () => {
    const widgets = resolvePipelineWidgetInputs(
      rulesWithAspectRatioConfig({ resolutions: [480, 720] }, [
        {
          key: "target_resolution",
          label: "Resolution",
          value_type: "int",
          options: [480, 720],
        },
      ]),
      WIDGET_OPTIONS,
    );

    const resolution = widgets.find(
      (widget) => widget.param === "target_resolution",
    );
    expect(resolution?.config.resolutionLadder).toBeUndefined();
    expect(resolution?.config.options).toEqual([480, 720]);
  });

  it("offers the aspect ratio selector when the rules expose its control", () => {
    const widgets = resolvePipelineWidgetInputs(
      rulesWithAspectRatioConfig({}, [
        { key: "target_resolution", label: "Resolution", value_type: "int" },
        {
          key: "target_aspect_ratio",
          label: "Aspect ratio",
          value_type: "string",
        },
      ]),
      WIDGET_OPTIONS,
    );

    const selector = widgets.find(
      (widget) => widget.param === "target_aspect_ratio",
    );
    expect(selector?.currentValue).toBe("auto");
    expect(selector?.config.options).toEqual([
      "auto",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16",
    ]);
    // "auto" names the project ratio it settles on with nothing to probe.
    expect(selector?.config.optionLabels?.auto).toBe(
      "Auto (input, else 16:9)",
    );
  });

  it("does not invent an aspect ratio selector for an undeclared control", () => {
    const widgets = resolvePipelineWidgetInputs(
      rulesWithAspectRatioConfig({}),
      WIDGET_OPTIONS,
    );

    expect(
      widgets.some((widget) => widget.param === "target_aspect_ratio"),
    ).toBe(false);
  });

  it("honors an author's opt-out of the aspect ratio selector", () => {
    const widgets = resolvePipelineWidgetInputs(
      rulesWithAspectRatioConfig({}, [
        { key: "target_resolution", label: "Resolution", value_type: "int" },
        {
          key: "target_aspect_ratio",
          value_type: "string",
          expose: "none",
        },
      ]),
      WIDGET_OPTIONS,
    );

    expect(
      widgets.some((widget) => widget.param === "target_aspect_ratio"),
    ).toBe(false);
  });
});

describe("custom overrides survive session widget validation", () => {
  it("accepts a short edge outside the ladder's range", () => {
    const widget = resolvePipelineWidgetInputs(
      rulesWithAspectRatioConfig({
        resolution_ladder: { min: 240, max: 720, steps: 5 },
      }),
      WIDGET_OPTIONS,
    ).find((candidate) => candidate.param === "target_resolution")!;

    // The panel snapshots exactly these constraints for the session to judge
    // widget writes against, so bounds here would veto the custom field.
    const constraints = {
      valueType: widget.config.valueType!,
      options: widget.config.options ?? null,
      min: widget.config.min ?? null,
      max: widget.config.max ?? null,
    };

    expect(checkWidgetValue(constraints, 1080, "Resolution")).toBeNull();
    expect(checkWidgetValue(constraints, 144, "Resolution")).toBeNull();
    expect(checkWidgetValue(constraints, 480, "Resolution")).toBeNull();
  });
});
