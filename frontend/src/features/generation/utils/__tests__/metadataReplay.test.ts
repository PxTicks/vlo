import { describe, expect, it } from "vitest";
import type { CreationMetadata } from "../../../../types/Asset";
import { canRegenerateFromAssetMetadata } from "../metadataReplay";

describe("canRegenerateFromAssetMetadata", () => {
  it("accepts generated metadata carrying a captured prompt or graph", () => {
    expect(
      canRegenerateFromAssetMetadata({
        source: "generated",
        workflowName: "ComfyUI (in-editor)",
        inputs: [],
        comfyuiPrompt: { "7": { class_type: "LoadImage", inputs: {} } },
      }),
    ).toBe(true);
    expect(
      canRegenerateFromAssetMetadata({
        source: "generated",
        workflowName: "ComfyUI (in-editor)",
        inputs: [],
        comfyuiWorkflow: { nodes: [] },
      }),
    ).toBe(true);
  });

  it("accepts generated metadata with a resolvable saved workflow name", () => {
    expect(
      canRegenerateFromAssetMetadata({
        source: "generated",
        workflowName: "wan2_2_flf2v.json",
        inputs: [],
      }),
    ).toBe(true);
  });

  it("rejects the adopted in-editor stub without a captured workflow", () => {
    // Legacy adopted deliveries carry only the placeholder label; offering
    // Regenerate would fail with "Could not find the saved workflow".
    expect(
      canRegenerateFromAssetMetadata({
        source: "generated",
        workflowName: "ComfyUI (in-editor)",
        inputs: [],
      }),
    ).toBe(false);
  });

  it("rejects placeholder names and non-generated sources", () => {
    expect(
      canRegenerateFromAssetMetadata({
        source: "generated",
        workflowName: "Unknown Workflow",
        inputs: [],
      }),
    ).toBe(false);
    expect(
      canRegenerateFromAssetMetadata({ source: "uploaded" } as CreationMetadata),
    ).toBe(false);
    expect(canRegenerateFromAssetMetadata(undefined)).toBe(false);
  });
});
