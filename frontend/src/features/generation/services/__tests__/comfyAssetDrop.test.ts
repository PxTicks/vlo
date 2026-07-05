import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { mergeInputNodeMap } from "../../constants/inputNodeMap";
import {
  buildComfyAssetDropPlan,
  stageAssetInComfyInput,
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

describe("stageAssetInComfyInput", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeAsset(): Asset {
    return {
      id: "asset-1",
      hash: "hash",
      name: "clip.mp4",
      type: "video",
      src: "blob:http://vlo.test/asset-1",
      createdAt: 0,
      file: new File(["bytes"], "clip.mp4", { type: "video/mp4" }),
    };
  }

  it("uploads the asset file and returns the subfolder-qualified name", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ name: "clip.mp4", subfolder: "staged", type: "input" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(stageAssetInComfyInput(makeAsset())).resolves.toBe(
      "staged/clip.mp4",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/upload/image");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("type")).toBe("input");
    expect((form.get("image") as File).name).toBe("clip.mp4");
  });

  it("surfaces upload failures with the response status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );

    await expect(stageAssetInComfyInput(makeAsset())).rejects.toThrow(
      /upload failed \(502\)/,
    );
  });
});
