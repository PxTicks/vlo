import { describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { mergeInputNodeMap } from "../../constants/inputNodeMap";
import { iframeBridge } from "../iframeBridgeClient";
import {
  buildComfyAssetDropPlan,
  dropAssetIntoComfyCanvas,
} from "../comfyAssetDrop";

describe("buildComfyAssetDropPlan", () => {
  it("targets every image loader and guards memory loaders behind disable_in_memory", () => {
    const plan = buildComfyAssetDropPlan("image", null, null);

    expect(plan.create).toEqual({ classType: "LoadImage", widget: "image" });
    expect(plan.targets).toContainEqual({
      classType: "LoadImage",
      widget: "image",
    });
    expect(plan.targets).toContainEqual({
      classType: "vloMemoryLoadImage",
      widget: "image",
      requiresTruthyWidget: "disable_in_memory",
    });
    // Legacy alias spellings are separate targets so node.type matches either.
    expect(plan.targets).toContainEqual({
      classType: "VLOMemoryLoadImage",
      widget: "image",
      requiresTruthyWidget: "disable_in_memory",
    });
    expect(plan.targets).toContainEqual({
      classType: "vloMemoryLoadImageBatch",
      widget: "images",
      requiresTruthyWidget: "disable_in_memory",
    });
    // Loaders for other media kinds are not drop targets for an image.
    expect(
      plan.targets.some((target) => target.classType === "VHS_LoadVideo"),
    ).toBe(false);
  });

  it("prefers VHS_LoadVideo when object_info reports it, else core LoadVideo", () => {
    const withVhs = buildComfyAssetDropPlan("video", null, {
      VHS_LoadVideo: {},
      LoadVideo: {},
    });
    expect(withVhs.create).toEqual({
      classType: "VHS_LoadVideo",
      widget: "video",
    });

    const coreOnly = buildComfyAssetDropPlan("video", null, { LoadVideo: {} });
    expect(coreOnly.create).toEqual({ classType: "LoadVideo", widget: "file" });
  });

  it("returns a target-only plan when no creatable loader exists upstream", () => {
    const plan = buildComfyAssetDropPlan("audio", null, { KSampler: {} });

    expect(plan.create).toBeNull();
    expect(plan.targets).toContainEqual({
      classType: "LoadAudio",
      widget: "audio",
    });
  });

  it("does not offer project LUTs to media loader nodes", () => {
    expect(buildComfyAssetDropPlan("lut", null, null)).toEqual({
      targets: [],
      create: null,
    });
  });

  it("includes dynamically discovered loaders from the merged input node map", () => {
    const merged = mergeInputNodeMap({
      CustomImageLoader: [{ input_type: "image", param: "picture" }],
    });

    const plan = buildComfyAssetDropPlan("image", merged, null);
    expect(plan.targets).toContainEqual({
      classType: "CustomImageLoader",
      widget: "picture",
    });
  });
});

describe("dropAssetIntoComfyCanvas", () => {
  const file = new File(["bytes"], "clip.mp4", { type: "video/mp4" });

  function makeAsset(): Asset {
    return {
      id: "asset-1",
      hash: "hash",
      name: "clip.mp4",
      type: "video",
      src: "blob:http://vlo.test/asset-1",
      createdAt: 0,
      file,
    };
  }

  it("sends the asset file to the bridge with the loader plan", async () => {
    const dropAsset = vi
      .spyOn(iframeBridge, "dropAsset")
      .mockResolvedValue({ action: "created", nodeId: "7", classType: "VHS_LoadVideo" });

    await expect(
      dropAssetIntoComfyCanvas({
        asset: makeAsset(),
        clientX: 120,
        clientY: 40,
        inputNodeMap: null,
        rawObjectInfo: { VHS_LoadVideo: {}, LoadVideo: {} },
      }),
    ).resolves.toEqual({
      action: "created",
      nodeId: "7",
      classType: "VHS_LoadVideo",
    });

    // The bytes cross once, unstaged: no upload precedes the bridge call.
    expect(dropAsset).toHaveBeenCalledWith({
      clientX: 120,
      clientY: 40,
      file,
      targets: expect.arrayContaining([
        { classType: "VHS_LoadVideo", widget: "video" },
      ]),
      create: { classType: "VHS_LoadVideo", widget: "video" },
    });

    dropAsset.mockRestore();
  });

  it("refuses asset types no loader accepts before touching the bridge", async () => {
    const dropAsset = vi.spyOn(iframeBridge, "dropAsset");

    await expect(
      dropAssetIntoComfyCanvas({
        asset: { ...makeAsset(), type: "lut" },
        clientX: 0,
        clientY: 0,
        inputNodeMap: null,
        rawObjectInfo: null,
      }),
    ).rejects.toThrow(/No ComfyUI loader accepts lut/);

    expect(dropAsset).not.toHaveBeenCalled();
    dropAsset.mockRestore();
  });
});
