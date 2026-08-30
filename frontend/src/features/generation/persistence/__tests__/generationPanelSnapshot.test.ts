import { describe, expect, it } from "vitest";
import { createDefaultWorkflowRules } from "../../services/workflowRules";
import type { Asset } from "../../../../types/Asset";
import type { WorkflowInput } from "../../types";
import { TEMP_WORKFLOW_ID } from "../../store/constants";
import {
  buildGenerationPanelSnapshot,
  parseGenerationPanelSnapshot,
  EMPTY_GENERATION_PANEL_VALUES,
} from "../generationPanelSnapshot";

const workflowInputs: WorkflowInput[] = [
  {
    id: "6:text",
    nodeId: "6",
    classType: "CLIPTextEncode",
    inputType: "text",
    param: "text",
    label: "Prompt",
    currentValue: "",
    origin: "rule",
  },
  {
    id: "774:file",
    nodeId: "774",
    classType: "vloMemoryLoadVideo",
    inputType: "video",
    param: "file",
    label: "Source video",
    currentValue: null,
    origin: "rule",
  },
];

function buildSnapshot(overrides: Partial<Parameters<typeof buildGenerationPanelSnapshot>[0]> = {}) {
  return buildGenerationPanelSnapshot({
    workflowId: "wan-i2v.json",
    workflowRules: createDefaultWorkflowRules(),
    workflowInputs,
    mediaInputs: {
      "774:file": {
        kind: "asset",
        asset: { id: "asset-1" } as Asset,
      },
    },
    targetResolution: 720,
    targetResolutionIsCustom: false,
    exactAspectRatio: false,
    aspectRatioSelection: "auto",
    maskCropMode: "crop",
    maskCropDilation: 0.1,
    values: {
      ...EMPTY_GENERATION_PANEL_VALUES,
      textValues: { "6:text": "a cat" },
      frontendStateWidgetValues: { "3:seed": 42 },
      widgetModes: { widget_mode_3_seed: "fixed" },
    },
    ...overrides,
  });
}

describe("generation panel snapshot", () => {
  it("captures the active workflow, its media and its panel values", () => {
    const snapshot = buildSnapshot();

    expect(snapshot?.workflowId).toBe("wan-i2v.json");
    expect(snapshot?.targetResolution).toBe(720);
    expect(snapshot?.inputs).toEqual([
      { nodeId: "774", kind: "draggedAsset", parentAssetId: "asset-1" },
    ]);
    expect(snapshot?.replayState?.textValues).toEqual({ "6:text": "a cat" });
    expect(snapshot?.replayState?.widgetValues).toEqual({ "3:seed": "42" });
  });

  it("saves nothing for a workflow the project does not own", () => {
    expect(buildSnapshot({ workflowId: null })).toBeNull();
    // The temporary tab's graph lives in ComfyUI's session, not the project.
    expect(buildSnapshot({ workflowId: TEMP_WORKFLOW_ID })).toBeNull();
  });

  it("round-trips through JSON", () => {
    const snapshot = buildSnapshot();
    const parsed = parseGenerationPanelSnapshot(
      JSON.parse(JSON.stringify(snapshot)),
    );

    expect(parsed).toEqual(snapshot);
  });

  it("keeps a custom short edge marked custom", () => {
    const snapshot = buildSnapshot({
      targetResolution: 733,
      targetResolutionIsCustom: true,
    });

    expect(snapshot?.targetResolutionIsCustom).toBe(true);
    expect(parseGenerationPanelSnapshot(JSON.parse(JSON.stringify(snapshot))))
      .toMatchObject({ targetResolution: 733, targetResolutionIsCustom: true });
  });

  it("drops entries it cannot interpret instead of failing the reopen", () => {
    const parsed = parseGenerationPanelSnapshot({
      version: 1,
      workflowId: "wan-i2v.json",
      inputs: [
        { nodeId: "774", kind: "draggedAsset", parentAssetId: "asset-1" },
        { nodeId: "775", kind: "somethingNewer", payload: {} },
        "not an input",
      ],
      unknownFutureField: true,
    });

    expect(parsed?.workflowId).toBe("wan-i2v.json");
    expect(parsed?.inputs).toEqual([
      { nodeId: "774", kind: "draggedAsset", parentAssetId: "asset-1" },
    ]);
  });

  it("rejects documents with no workflow to return to", () => {
    expect(parseGenerationPanelSnapshot(null)).toBeNull();
    expect(parseGenerationPanelSnapshot({ version: 1 })).toBeNull();
    expect(
      parseGenerationPanelSnapshot({ version: 2, workflowId: "a.json" }),
    ).toBeNull();
  });
});
