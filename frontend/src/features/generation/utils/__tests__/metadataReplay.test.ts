import { describe, expect, it } from "vitest";
import type {
  Asset,
  CreationMetadata,
  GeneratedCreationMetadata,
} from "../../../../types/Asset";
import { prepareAssetForPersistence } from "../../../project/services/ProjectPersistenceService";
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

  it("accepts metadata whose replay payload was split into the sidecar", () => {
    // What the asset index holds after a reload: the payload is on disk, not
    // in memory, and the gate runs before hydration.
    expect(
      canRegenerateFromAssetMetadata({
        source: "generated",
        workflowName: "ComfyUI (in-editor)",
        inputs: [],
        generatedInEditor: true,
        replayPayloadInSidecar: true,
      }),
    ).toBe(true);
  });

  it("rejects the adopted in-editor stub without a captured workflow", () => {
    // An adopted delivery whose history enrichment never landed carries only
    // the placeholder label; offering Regenerate would fail with "Could not
    // find the saved workflow".
    expect(
      canRegenerateFromAssetMetadata({
        source: "generated",
        workflowName: "ComfyUI (in-editor)",
        inputs: [],
        generatedInEditor: true,
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

describe("canRegenerateFromAssetMetadata across a project reload", () => {
  // The asset index entry is exactly what the store loads back into memory, so
  // the gate has to survive the persistence split for in-editor and panel
  // generations alike.
  function reloadedMetadata(
    metadata: GeneratedCreationMetadata,
  ): CreationMetadata | undefined {
    return prepareAssetForPersistence({
      id: "asset-1",
      hash: "hash-1",
      name: "output.mp4",
      type: "video",
      src: ".vloproject/assets/output.mp4",
      sourcePath: ".vloproject/assets/output.mp4",
      createdAt: 1,
      creationMetadata: metadata,
    } as Asset).entry.creationMetadata;
  }

  const replayPayload = {
    comfyuiPrompt: { "1": { class_type: "KSampler", inputs: {} } },
    comfyuiWorkflow: { nodes: [] },
  };

  it("keeps Regenerate on adopted in-editor generations", () => {
    expect(
      canRegenerateFromAssetMetadata(
        reloadedMetadata({
          source: "generated",
          workflowName: "ComfyUI (in-editor)",
          inputs: [],
          generatedInEditor: true,
          ...replayPayload,
        }),
      ),
    ).toBe(true);
  });

  it("keeps Regenerate on panel generations", () => {
    expect(
      canRegenerateFromAssetMetadata(
        reloadedMetadata({
          source: "generated",
          workflowName: "wan2_2_flf2v",
          inputs: [],
          ...replayPayload,
        }),
      ),
    ).toBe(true);
  });

  it("survives re-persisting an asset whose sidecar is not hydrated", () => {
    // updateAsset (rename, favourite) re-prepares whatever the store holds,
    // which after a reload is the abridged copy — it must not drop the marker
    // or the sidecar reference.
    const reloaded = reloadedMetadata({
      source: "generated",
      workflowName: "ComfyUI (in-editor)",
      inputs: [],
      generatedInEditor: true,
      ...replayPayload,
    });

    const rewritten = prepareAssetForPersistence({
      id: "asset-1",
      hash: "hash-1",
      name: "renamed.mp4",
      type: "video",
      src: ".vloproject/assets/output.mp4",
      sourcePath: ".vloproject/assets/output.mp4",
      createdAt: 1,
      creationMetadata: reloaded,
      metadataRef: "asset-metadata/asset-1.json",
      metadataLoaded: false,
    } as Asset);

    expect(rewritten.entry.metadataRef).toBe("asset-metadata/asset-1.json");
    expect(canRegenerateFromAssetMetadata(rewritten.entry.creationMetadata)).toBe(
      true,
    );
  });
});
