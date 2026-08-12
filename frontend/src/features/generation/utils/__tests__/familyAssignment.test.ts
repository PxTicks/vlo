import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Asset,
  AssetFamily,
  AssetFamilyCompatibility,
  GeneratedCreationInput,
} from "../../../../types/Asset";
import type { SlotValue } from "../../pipeline/types";
import type { WorkflowInput } from "../../types";
import {
  buildGenerationFamilyAutoMatchKey,
  buildGenerationFamilyRequestKey,
  resolveFamilyForGenerationMatchKey,
} from "../familyAssignment";

const { getAssetByIdMock } = vi.hoisted(() => ({
  getAssetByIdMock: vi.fn(),
}));

vi.mock("../../../userAssets/api", () => ({
  getAssetById: getAssetByIdMock,
}));

const workflowInputs: WorkflowInput[] = [
  {
    nodeId: "1",
    classType: "CLIPTextEncode",
    inputType: "text",
    param: "text",
    label: "Prompt",
    currentValue: "",
    origin: "rule",
  },
  {
    nodeId: "2",
    classType: "LoadImage",
    inputType: "image",
    param: "image",
    label: "Image",
    currentValue: null,
    origin: "rule",
  },
];

const generationInputs: GeneratedCreationInput[] = [
  {
    nodeId: "2",
    kind: "draggedAsset",
    parentAssetId: "asset-source",
  },
];

const sourceAsset: Asset = {
  id: "asset-source",
  hash: "source-hash",
  name: "input.png",
  type: "image",
  src: "input.png",
  createdAt: 1,
};

function makeWorkflow(seed: number, imageNodeSource = "2") {
  return {
    "1": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "hello world",
        clip: ["3", 0],
      },
    },
    "2": {
      class_type: "LoadImage",
      inputs: {
        image: "input.png",
      },
    },
    "3": {
      class_type: "ImageConsumer",
      inputs: {
        image: [imageNodeSource, 0],
        seed,
      },
    },
  };
}

function makeGraphWorkflow(sourceNodeId = 2, imageName = "input.png") {
  return {
    nodes: [
      {
        id: 1,
        type: "CLIPTextEncode",
        inputs: [{ name: "clip", link: 11 }],
        widgets_values: ["hello world"],
      },
      {
        id: 2,
        type: "LoadImage",
        inputs: [],
        widgets_values: [imageName],
      },
      {
        id: 3,
        type: "ImageConsumer",
        inputs: [{ name: "image", link: 12 }],
        widgets_values: [123],
      },
      {
        id: 4,
        type: "CLIPLoader",
        inputs: [],
        widgets_values: ["clip.safetensors"],
      },
    ],
    links: [
      [11, 4, 0, 1, 0, "CLIP"],
      [12, sourceNodeId, 0, 3, 0, "IMAGE"],
    ],
  };
}

function makeSlotValues(prompt: string): Record<string, SlotValue> {
  return {
    "1:text": {
      type: "text",
      value: prompt,
    },
    "2:image": {
      type: "image",
      file: new File(["image-bytes"], "input.png", { type: "image/png" }),
    },
  };
}

const compatibility: AssetFamilyCompatibility = {
  assetType: "video",
  durationMs: 5000,
  fpsMilli: 24000,
};

describe("familyAssignment", () => {
  beforeEach(() => {
    getAssetByIdMock.mockReset();
    getAssetByIdMock.mockReturnValue(sourceAsset);
  });

  it("treats seed differences as the same family when structure and inputs match", async () => {
    const left = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });
    const right = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(99999),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });

    expect(left).not.toBeNull();
    expect(left).toBe(right);
  });

  it("changes the family hash when the text prompt changes", async () => {
    const left = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });
    const right = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs,
      slotValues: makeSlotValues("different prompt"),
      generationInputs,
    });

    expect(left).not.toBe(right);
  });

  it("includes the order of repeatable media slots in the family key", async () => {
    const repeatableInput: WorkflowInput = {
      id: "141:images",
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      origin: "rule",
      presentation: { repeatable: { max: 2 } },
    };
    const first = { ...sourceAsset, id: "first", hash: "first-hash" };
    const second = { ...sourceAsset, id: "second", hash: "second-hash" };
    getAssetByIdMock.mockImplementation((id: string) =>
      id === first.id ? first : second,
    );
    const slotValues: Record<string, SlotValue> = {
      "141:images": {
        type: "image",
        file: new File(["first"], "first.png", { type: "image/png" }),
      },
      "141:images::repeat::1": {
        type: "image",
        file: new File(["second"], "second.png", { type: "image/png" }),
      },
    };
    const makeInputs = (firstId: string, secondId: string) => [
      {
        nodeId: "141",
        inputId: "141:images",
        kind: "draggedAsset" as const,
        parentAssetId: firstId,
      },
      {
        nodeId: "141",
        inputId: "141:images::repeat::1",
        kind: "draggedAsset" as const,
        parentAssetId: secondId,
      },
    ];

    const original = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs: [repeatableInput],
      slotValues,
      generationInputs: makeInputs("first", "second"),
    });
    const swapped = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs: [repeatableInput],
      slotValues,
      generationInputs: makeInputs("second", "first"),
    });

    expect(original).not.toBe(swapped);
  });

  it("changes the family hash when the workflow wiring changes", async () => {
    const left = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1, "2"),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });
    const right = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1, "1"),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });

    expect(left).not.toBe(right);
  });

  it("groups graph workflows by topology while ignoring widget values", async () => {
    const left = await buildGenerationFamilyRequestKey({
      workflow: makeGraphWorkflow(2, "input-a.png"),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });
    const right = await buildGenerationFamilyRequestKey({
      workflow: makeGraphWorkflow(2, "input-b.png"),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });

    expect(left).not.toBeNull();
    expect(left).toBe(right);
  });

  it("changes the family hash when graph workflow wiring changes", async () => {
    const left = await buildGenerationFamilyRequestKey({
      workflow: makeGraphWorkflow(2),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });
    const right = await buildGenerationFamilyRequestKey({
      workflow: makeGraphWorkflow(4),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });

    expect(left).not.toBe(right);
  });

  it("changes the match key when compatibility changes", async () => {
    const requestKey = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });

    const left = await buildGenerationFamilyAutoMatchKey(requestKey, compatibility);
    const right = await buildGenerationFamilyAutoMatchKey(requestKey, {
      ...compatibility,
      durationMs: 7000,
    });

    expect(left).not.toBeNull();
    expect(left).not.toBe(right);
  });

  it("does not create or resolve auto-families for incomplete compatibility", async () => {
    const requestKey = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });
    const incompleteCompatibility: AssetFamilyCompatibility = {
      assetType: "video",
      durationMs: 5000,
      fpsMilli: null,
    };

    expect(
      await buildGenerationFamilyAutoMatchKey(
        requestKey,
        incompleteCompatibility,
      ),
    ).toBeNull();
    expect(
      resolveFamilyForGenerationMatchKey(
        [],
        "generation-family:v1:test",
        incompleteCompatibility,
      ),
    ).toBeUndefined();
  });

  it("reuses an existing family id when the match key already exists", async () => {
    const requestKey = await buildGenerationFamilyRequestKey({
      workflow: makeWorkflow(1),
      workflowInputs,
      slotValues: makeSlotValues("hello world"),
      generationInputs,
    });
    const familyMatchKey = await buildGenerationFamilyAutoMatchKey(
      requestKey,
      compatibility,
    );
    const families: AssetFamily[] = [
      {
        id: "family-id",
        representativeAssetId: "existing-asset",
        autoMatchKeys: [familyMatchKey!],
        compatibility,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const family = resolveFamilyForGenerationMatchKey(
      families,
      familyMatchKey,
      compatibility,
    );

    expect(family).toEqual({
      id: "family-id",
      representativeAssetId: "existing-asset",
      autoMatchKeys: [familyMatchKey],
      compatibility,
      createdAt: 1,
      updatedAt: 1,
    });
  });
});
