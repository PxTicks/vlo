import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssetFamily,
  AssetFamilyCompatibility,
  GeneratedCreationMetadata,
} from "../../../../types/Asset";
import { useProjectStore } from "../../../project";
import * as inputSelection from "../../utils/inputSelection";
import * as mediaUtils from "../../pipeline/utils/media";
import { buildGenerationFamilyAutoMatchKey } from "../familyAssignment";

const {
  mockAddLocalAsset,
  mockAddLocalAssetWithFamily,
  mockGetFamilies,
  mockInspectAssetFamilyCompatibility,
  mockFetchOutputAsFile,
  mockPackageFramesAndAudioToVideo,
  mockUpsertFamily,
} = vi.hoisted(() => ({
  mockAddLocalAsset: vi.fn(),
  mockAddLocalAssetWithFamily: vi.fn(),
  mockGetFamilies: vi.fn<() => AssetFamily[]>(() => []),
  mockInspectAssetFamilyCompatibility: vi.fn<
    () => Promise<AssetFamilyCompatibility | null>
  >(),
  mockFetchOutputAsFile: vi.fn(),
  mockPackageFramesAndAudioToVideo: vi.fn(),
  mockUpsertFamily: vi.fn(),
}));

vi.mock("../../services/comfyuiApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/comfyuiApi")>();
  return {
    ...actual,
    fetchOutputAsFile: mockFetchOutputAsFile,
  };
});

vi.mock("../../pipeline/utils/videoPackaging", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../pipeline/utils/videoPackaging")>();
  return {
    ...actual,
    packageFramesAndAudioToVideo: mockPackageFramesAndAudioToVideo,
  };
});

vi.mock("../../../userAssets", () => ({
  addLocalAsset: mockAddLocalAsset,
  addLocalAssetWithFamily: mockAddLocalAssetWithFamily,
  getAssetById: vi.fn(() => undefined),
  getFamilies: mockGetFamilies,
  inspectAssetFamilyCompatibility: mockInspectAssetFamilyCompatibility,
  upsertFamily: mockUpsertFamily,
}));

import { frontendPostprocess, frontendPreprocess } from "../pipeline";

function makeGenerationMetadata(): GeneratedCreationMetadata {
  return {
    source: "generated",
    workflowName: "Workflow",
    inputs: [],
  };
}

describe("generation pipeline", () => {
  beforeEach(() => {
    mockAddLocalAsset.mockReset();
    mockAddLocalAssetWithFamily.mockReset();
    mockGetFamilies.mockReset();
    mockGetFamilies.mockReturnValue([]);
    mockInspectAssetFamilyCompatibility.mockReset();
    mockInspectAssetFamilyCompatibility.mockResolvedValue({
      assetType: "image",
      durationMs: 5000,
      fpsMilli: null,
    });
    mockFetchOutputAsFile.mockReset();
    mockPackageFramesAndAudioToVideo.mockReset();
    mockUpsertFamily.mockReset();
    vi.restoreAllMocks();
    if (!("createObjectURL" in URL)) {
      Object.defineProperty(URL, "createObjectURL", {
        value: () => "blob:postprocessed-preview",
        writable: true,
      });
    }
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => "blob:postprocessed-preview",
    );
  });

  it("prefers the first visual input aspect ratio over the project aspect ratio", async () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        aspectRatio: "16:9",
        fps: 30,
      },
    }));
    const imageFile = new File(["image"], "input.png", { type: "image/png" });
    const aspectRatioSpy = vi
      .spyOn(mediaUtils, "probeVisualFileAspectRatio")
      .mockResolvedValue("1:1");

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "image_input",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Image Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        image_input: {
          type: "image",
          file: imageFile,
        },
      },
      "client-id",
      [],
      undefined,
      {
        targetResolution: 1080,
      },
    );

    expect(aspectRatioSpy).toHaveBeenCalledWith(imageFile);
    expect(request.targetAspectRatio).toBe("1:1");
    expect(request.exactAspectRatio).toBe(false);
    expect(request.targetResolution).toBe(1080);
  });

  it("falls back to the project aspect ratio when no visual input is available", async () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        aspectRatio: "9:16",
        fps: 24,
      },
    }));

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [],
      {},
      "client-id",
      [],
      undefined,
      {
        targetResolution: 720,
      },
    );

    expect(request.targetAspectRatio).toBe("9:16");
    expect(request.exactAspectRatio).toBe(false);
    expect(request.targetResolution).toBe(720);
  });

  it("routes audio workflow inputs without affecting visual aspect-ratio selection", async () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        aspectRatio: "9:16",
        fps: 24,
      },
    }));

    const audioFile = new File(["audio"], "input.wav", { type: "audio/wav" });

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "audio_input",
          classType: "LoadAudio",
          inputType: "audio",
          param: "audio",
          label: "Audio Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        audio_input: {
          type: "audio",
          file: audioFile,
        },
      },
      "client-id",
    );

    expect(request.audioInputs).toEqual({ audio_input: audioFile });
    expect(request.targetAspectRatio).toBe("9:16");
  });

  it("normalizes off-grid input aspect ratios to the nearest supported ratio when exact matching is disabled", async () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        aspectRatio: "16:9",
        fps: 30,
      },
    }));

    const imageFile = new File(["image"], "input.png", { type: "image/png" });
    vi.spyOn(mediaUtils, "probeVisualFileAspectRatio").mockResolvedValue(
      "179:100",
    );
    const cropSpy = vi
      .spyOn(mediaUtils, "maybeCropVisualFileToAspectRatio")
      .mockResolvedValue(imageFile);

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "image_input",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Image Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        image_input: {
          type: "image",
          file: imageFile,
        },
      },
      "client-id",
      [],
      undefined,
      {
        exactAspectRatio: false,
      },
    );

    expect(request.targetAspectRatio).toBe("16:9");
    expect(request.exactAspectRatio).toBe(false);
    expect(cropSpy).toHaveBeenCalledWith(imageFile, "16:9");
  });

  it("keeps off-grid input aspect ratios when exact matching is enabled", async () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        aspectRatio: "16:9",
        fps: 30,
      },
    }));

    const imageFile = new File(["image"], "input.png", { type: "image/png" });
    vi.spyOn(mediaUtils, "probeVisualFileAspectRatio").mockResolvedValue(
      "179:100",
    );
    const cropSpy = vi.spyOn(mediaUtils, "maybeCropVisualFileToAspectRatio");

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "image_input",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Image Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        image_input: {
          type: "image",
          file: imageFile,
        },
      },
      "client-id",
      [],
      undefined,
      {
        exactAspectRatio: true,
      },
    );

    expect(request.targetAspectRatio).toBe("179:100");
    expect(request.exactAspectRatio).toBe(true);
    expect(cropSpy).not.toHaveBeenCalled();
  });

  it("includes runtime mask crop mode and suppresses dilation for full mode", async () => {
    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [],
      {},
      "client-id",
      [
        {
          sourceNodeId: "1",
          maskNodeId: "2",
          maskParam: "file",
          maskType: "binary",
        },
      ],
      0.2,
      {
        maskCropMode: "full",
      },
    );

    expect(request.maskCropMode).toBe("full");
    expect(request.maskCropDilation).toBeUndefined();
  });

  it("forwards derived-mask renders into the selection renderer", async () => {
    const renderSpy = vi
      .spyOn(inputSelection, "renderTimelineSelectionToMp4WithDerivedMasks")
      .mockResolvedValue({
        video: new File(["video"], "selection.mp4", { type: "video/mp4" }),
        masks: {
          video_binary: new File(["mask"], "selection-mask.mp4", {
            type: "video/mp4",
          }),
        },
        maskContentByKey: {
          video_binary: true,
        },
      });

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          type: "video_selection",
          selection: {
            start: 0,
            end: 24,
            clips: [],
            fps: 24,
          },
        },
      },
      "client-id",
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
        },
      ],
    );

    expect(renderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        start: 0,
        end: 24,
        fps: 24,
      }),
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
        },
      ],
      {
        preparedMaskFile: undefined,
        preparedVideoFile: undefined,
        signal: undefined,
      },
    );
    expect(request.videoInputs.video_input.name).toBe("selection.mp4");
    expect(request.videoInputs.mask_input.name).toBe("selection-mask.mp4");
  });

  it("reuses cached derived-mask renders when prepared files are available", async () => {
    const renderSpy = vi.spyOn(
      inputSelection,
      "renderTimelineSelectionToMp4WithDerivedMasks",
    );
    const preparedVideoFile = new File(["video"], "prepared.mp4", {
      type: "video/mp4",
    });
    const preparedMaskFile = new File(["mask"], "prepared-mask.mp4", {
      type: "video/mp4",
    });

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          type: "video_selection",
          selection: {
            start: 0,
            end: 24,
            clips: [],
            fps: 24,
          },
          preparedVideoFile,
          preparedMaskFile,
        },
      },
      "client-id",
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
        },
      ],
    );

    expect(renderSpy).not.toHaveBeenCalled();
    expect(request.videoInputs.video_input).toBe(preparedVideoFile);
    expect(request.videoInputs.mask_input).toBe(preparedMaskFile);
  });

  it("routes audio-timing derived masks to their own hidden video inputs", async () => {
    vi.spyOn(
      inputSelection,
      "renderTimelineSelectionToMp4WithDerivedMasks",
    ).mockResolvedValue({
      video: new File(["video"], "selection.mp4", { type: "video/mp4" }),
      masks: {
        video_binary: new File(["visual-mask"], "selection-mask.mp4", {
          type: "video/mp4",
        }),
        audio_timing_binary_25: new File(
          ["audio-mask"],
          "selection-audio-mask.mp4",
          { type: "video/mp4" },
        ),
      },
      maskContentByKey: {
        video_binary: true,
        audio_timing_binary_25: true,
      },
    });

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          type: "video_selection",
          selection: {
            start: 0,
            end: 24,
            clips: [],
            fps: 24,
          },
        },
      },
      "client-id",
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
        },
        {
          sourceNodeId: "video_input",
          maskNodeId: "audio_mask_input",
          maskParam: "file",
          maskType: "binary",
          purpose: "audio_timing",
        },
      ],
    );

    expect(request.videoInputs.video_input.name).toBe("selection.mp4");
    expect(request.videoInputs.mask_input.name).toBe("selection-mask.mp4");
    expect(request.videoInputs.audio_mask_input.name).toBe(
      "selection-audio-mask.mp4",
    );
  });

  it("keeps optional derived masks when the selection carries mask_ref-backed geometry", async () => {
    const derivedRenderSpy = vi
      .spyOn(inputSelection, "renderTimelineSelectionToMp4WithDerivedMasks")
      .mockResolvedValue({
        video: new File(["video"], "selection.mp4", { type: "video/mp4" }),
        masks: {
          video_binary: new File(["mask"], "selection-mask.mp4", {
            type: "video/mp4",
          }),
        },
        maskContentByKey: {
          video_binary: true,
        },
      });
    const plainRenderSpy = vi.spyOn(inputSelection, "renderTimelineSelectionToMp4");

    await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          type: "video_selection",
          selection: {
            start: 0,
            end: 24,
            fps: 24,
            clips: [
              {
                id: "clip-visual",
                type: "video",
                name: "Visual Clip",
                assetId: "asset-1",
                sourceDuration: 24,
                transformedDuration: 24,
                transformedOffset: 0,
                timelineDuration: 24,
                croppedSourceDuration: 24,
                offset: 0,
                transformations: [],
                trackId: "track-1",
                start: 0,
                components: [
                  {
                    id: "mask-ref-1",
                    type: "mask_ref",
                    parameters: {
                      maskClipId: "clip-mask",
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      "client-id",
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
          optional: true,
        },
      ],
    );

    expect(derivedRenderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        start: 0,
        end: 24,
        fps: 24,
      }),
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
          optional: true,
        },
      ],
      {
        preparedMaskFile: undefined,
        preparedVideoFile: undefined,
        signal: undefined,
      },
    );
    expect(plainRenderSpy).not.toHaveBeenCalled();
  });

  it("drops optional derived mask uploads when the rendered mask output is empty", async () => {
    vi.spyOn(inputSelection, "renderTimelineSelectionToMp4WithDerivedMasks")
      .mockResolvedValue({
        video: new File(["video"], "selection.mp4", { type: "video/mp4" }),
        masks: {
          video_binary: new File(["mask"], "selection-mask.mp4", {
            type: "video/mp4",
          }),
        },
        maskContentByKey: {
          video_binary: false,
        },
      });

    const request = await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          type: "video_selection",
          selection: {
            start: 0,
            end: 24,
            clips: [],
            fps: 24,
          },
        },
      },
      "client-id",
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
          optional: true,
        },
      ],
    );

    expect(request.videoInputs.video_input.name).toBe("selection.mp4");
    expect(request.videoInputs.mask_input).toBeUndefined();
  });

  it("re-renders optional masks instead of reusing cached prepared mask files", async () => {
    const renderSpy = vi
      .spyOn(inputSelection, "renderTimelineSelectionToMp4WithDerivedMasks")
      .mockResolvedValue({
        video: new File(["video"], "selection.mp4", { type: "video/mp4" }),
        masks: {
          video_binary: new File(["mask"], "selection-mask.mp4", {
            type: "video/mp4",
          }),
        },
        maskContentByKey: {
          video_binary: true,
        },
      });
    const preparedVideoFile = new File(["video"], "prepared.mp4", {
      type: "video/mp4",
    });
    const preparedMaskFile = new File(["mask"], "prepared-mask.mp4", {
      type: "video/mp4",
    });

    await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          type: "video_selection",
          selection: {
            start: 0,
            end: 24,
            clips: [],
            fps: 24,
          },
          preparedVideoFile,
          preparedMaskFile,
        },
      },
      "client-id",
      [
        {
          sourceNodeId: "video_input",
          maskNodeId: "mask_input",
          maskParam: "file",
          maskType: "binary",
          optional: true,
        },
      ],
    );

    expect(renderSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        preparedMaskFile: undefined,
        preparedVideoFile,
        signal: undefined,
      },
    );
  });

  it("forwards abort signals into timeline-selection render helpers", async () => {
    const renderSpy = vi
      .spyOn(inputSelection, "renderTimelineSelectionToMp4")
      .mockResolvedValue(
        new File(["video"], "selection.mp4", { type: "video/mp4" }),
      );
    const controller = new AbortController();

    await frontendPreprocess(
      {},
      "workflow.json",
      [
        {
          nodeId: "video_input",
          classType: "LoadVideo",
          inputType: "video",
          param: "file",
          label: "Video Input",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          type: "video_selection",
          selection: {
            start: 0,
            end: 24,
            clips: [],
            fps: 24,
          },
        },
      },
      "client-id",
      [],
      undefined,
      { signal: controller.signal },
    );

    expect(renderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        start: 0,
        end: 24,
        fps: 24,
      }),
      { signal: controller.signal },
    );
  });

  it("propagates AbortError for cancelled preprocess without rendering outputs", async () => {
    const renderSpy = vi.spyOn(inputSelection, "renderTimelineSelectionToMp4");
    const controller = new AbortController();
    controller.abort();

    await expect(
      frontendPreprocess(
        {},
        "workflow.json",
        [
          {
            nodeId: "video_input",
            classType: "LoadVideo",
            inputType: "video",
            param: "file",
            label: "Video Input",
            currentValue: null,
            origin: "rule",
          },
        ],
        {
          video_input: {
            type: "video_selection",
            selection: {
              start: 0,
              end: 24,
              clips: [],
              fps: 24,
            },
          },
        },
        "client-id",
        [],
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("packages stitched video outputs into a single imported asset", async () => {
    const frameOne = new File(["frame-1"], "frame_0001.png", {
      type: "image/png",
    });
    const frameTwo = new File(["frame-2"], "frame_0002.png", {
      type: "image/png",
    });
    const audio = new File(["audio"], "sound.wav", { type: "audio/wav" });
    const packagedVideo = new File(["video"], "stitched.mp4", {
      type: "video/mp4",
    });

    mockFetchOutputAsFile
      .mockResolvedValueOnce(frameOne)
      .mockResolvedValueOnce(frameTwo)
      .mockResolvedValueOnce(audio);
    mockPackageFramesAndAudioToVideo.mockResolvedValue({
      file: packagedVideo,
      compatibility: {
        assetType: "video",
        durationMs: 2000,
        fpsMilli: 12000,
      },
    });
    mockAddLocalAsset.mockResolvedValue({ id: "asset-packaged" });

    const result = await frontendPostprocess(
      [
        {
          filename: "frame_0001.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame-1",
        },
        {
          filename: "frame_0002.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame-2",
        },
        {
          filename: "sound.wav",
          subfolder: "",
          type: "output",
          viewUrl: "/sound",
        },
      ],
      {
        postprocessing: {
          mode: "stitch_frames_with_audio",
          panel_preview: "replace_outputs",
          on_failure: "fallback_raw",
          stitch_fps: 12,
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockFetchOutputAsFile).toHaveBeenNthCalledWith(
      1,
      "frame_0001.png",
      "",
      "output",
      "/frame-1",
    );
    expect(mockFetchOutputAsFile).toHaveBeenNthCalledWith(
      2,
      "frame_0002.png",
      "",
      "output",
      "/frame-2",
    );
    expect(mockFetchOutputAsFile).toHaveBeenNthCalledWith(
      3,
      "sound.wav",
      "",
      "output",
      "/sound",
    );
    expect(mockPackageFramesAndAudioToVideo).toHaveBeenCalledWith(
      [frameOne, frameTwo],
      audio,
      12,
    );
    expect(mockAddLocalAsset).toHaveBeenCalledTimes(1);
    expect(mockAddLocalAsset).toHaveBeenCalledWith(
      packagedVideo,
      makeGenerationMetadata(),
    );
    expect(result).toEqual({
      postprocessedPreview: {
        previewUrl: "blob:postprocessed-preview",
        mediaKind: "video",
        filename: "stitched.mp4",
      },
      postprocessError: null,
      importedAssetIds: ["asset-packaged"],
    });
  });

  it("fetches memory-backed outputs via their explicit view url", async () => {
    const output = new File(["video"], "memory-output.mp4", {
      type: "video/mp4",
    });

    mockFetchOutputAsFile.mockResolvedValue(output);
    mockAddLocalAsset.mockResolvedValue({ id: "asset-memory-video" });

    const result = await frontendPostprocess(
      [
        {
          filename: "ComfyUI_00001_.mp4",
          subfolder: "video",
          type: "output",
          viewUrl: "/api/vlo-memory/view/media-123",
        },
      ],
      {
        postprocessing: {
          mode: "none",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockFetchOutputAsFile).toHaveBeenCalledWith(
      "ComfyUI_00001_.mp4",
      "video",
      "output",
      "/api/vlo-memory/view/media-123",
    );
    expect(mockAddLocalAsset).toHaveBeenCalledWith(
      output,
      makeGenerationMetadata(),
    );
    expect(result).toEqual({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-memory-video"],
    });
  });

  it("skips generation-mask attachment when postprocessing disables it", async () => {
    const output = new File(["video"], "raw-output.mp4", {
      type: "video/mp4",
    });
    const preparedMaskFile = new File(["mask"], "prepared-mask.mp4", {
      type: "video/mp4",
    });
    const metadata = makeGenerationMetadata();

    mockFetchOutputAsFile.mockResolvedValue(output);
    mockAddLocalAsset.mockResolvedValue({ id: "asset-raw-video" });

    const result = await frontendPostprocess(
      [
        {
          filename: "ComfyUI_00001_.mp4",
          subfolder: "video",
          type: "output",
          viewUrl: "/api/vlo-memory/view/raw-output",
        },
      ],
      {
        postprocessing: {
          mode: "none",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
          attach_generation_mask: false,
        },
        aspectRatioProcessing: null,
        generationMetadata: metadata,
        previewFrameFiles: null,
        preparedMaskFile,
      },
    );

    expect(mockAddLocalAsset).toHaveBeenCalledTimes(1);
    expect(mockAddLocalAsset).toHaveBeenCalledWith(output, metadata);
    expect(metadata.generationMaskAssetId).toBeUndefined();
    expect(result).toEqual({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-raw-video"],
    });
  });

  it("returns a single-frame PNG with message when stitch mode has only one frame", async () => {
    mockFetchOutputAsFile.mockResolvedValue(
      new File(["frame-1"], "frame_0001.png", {
        type: "image/png",
      }),
    );
    mockAddLocalAsset.mockResolvedValue({ id: "asset-frame-only" });

    const result = await frontendPostprocess(
      [
        {
          filename: "frame_0001.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame-1",
        },
      ],
      {
        postprocessing: {
          mode: "stitch_frames_with_audio",
          panel_preview: "replace_outputs",
          on_failure: "show_error",
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockPackageFramesAndAudioToVideo).not.toHaveBeenCalled();
    expect(mockAddLocalAsset).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      postprocessedPreview: {
        previewUrl: "blob:postprocessed-preview",
        mediaKind: "image",
        filename: "frame_0001.png",
      },
      postprocessError:
        "Only one frame was generated; returning the PNG output.",
      importedAssetIds: ["asset-frame-only"],
    });
  });

  it("stitches frame outputs without audio when auto mode is active", async () => {
    const frameOne = new File(["frame-1"], "frame_0001.png", {
      type: "image/png",
    });
    const frameTwo = new File(["frame-2"], "frame_0002.png", {
      type: "image/png",
    });
    const packagedVideo = new File(["video"], "stitched-silent.mp4", {
      type: "video/mp4",
    });

    mockFetchOutputAsFile
      .mockResolvedValueOnce(frameOne)
      .mockResolvedValueOnce(frameTwo);
    mockPackageFramesAndAudioToVideo.mockResolvedValue({
      file: packagedVideo,
      compatibility: {
        assetType: "video",
        durationMs: 167,
        fpsMilli: 12000,
      },
    });
    mockAddLocalAsset.mockResolvedValue({ id: "asset-packaged-silent" });

    const result = await frontendPostprocess(
      [
        {
          filename: "frame_0001.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame-1",
        },
        {
          filename: "frame_0002.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame-2",
        },
      ],
      {
        postprocessing: {
          mode: "auto",
          panel_preview: "replace_outputs",
          on_failure: "fallback_raw",
          stitch_fps: 12,
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockPackageFramesAndAudioToVideo).toHaveBeenCalledWith(
      [frameOne, frameTwo],
      null,
      12,
    );
    expect(mockAddLocalAsset).toHaveBeenCalledTimes(1);
    expect(mockAddLocalAsset).toHaveBeenCalledWith(
      packagedVideo,
      makeGenerationMetadata(),
    );
    expect(result).toEqual({
      postprocessedPreview: {
        previewUrl: "blob:postprocessed-preview",
        mediaKind: "video",
        filename: "stitched-silent.mp4",
      },
      postprocessError: null,
      importedAssetIds: ["asset-packaged-silent"],
    });
  });

  it("stitches websocket-only frame outputs in auto mode", async () => {
    const previewFrameOne = new File(["frame-1"], "ws_0001.png", {
      type: "image/png",
    });
    const previewFrameTwo = new File(["frame-2"], "ws_0002.png", {
      type: "image/png",
    });
    const packagedVideo = new File(["video"], "stitched-ws.mp4", {
      type: "video/mp4",
    });

    mockPackageFramesAndAudioToVideo.mockResolvedValue({
      file: packagedVideo,
      compatibility: {
        assetType: "video",
        durationMs: 167,
        fpsMilli: 12000,
      },
    });
    mockAddLocalAsset.mockResolvedValue({ id: "asset-packaged-ws" });

    const result = await frontendPostprocess(
      [],
      {
        postprocessing: {
          mode: "auto",
          panel_preview: "replace_outputs",
          on_failure: "fallback_raw",
          stitch_fps: 12,
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: [previewFrameOne, previewFrameTwo],
      },
    );

    expect(mockFetchOutputAsFile).not.toHaveBeenCalled();
    expect(mockPackageFramesAndAudioToVideo).toHaveBeenCalledWith(
      [previewFrameOne, previewFrameTwo],
      null,
      12,
    );
    expect(mockAddLocalAsset).toHaveBeenCalledTimes(1);
    expect(mockAddLocalAsset).toHaveBeenCalledWith(
      packagedVideo,
      makeGenerationMetadata(),
    );
    expect(result).toEqual({
      postprocessedPreview: {
        previewUrl: "blob:postprocessed-preview",
        mediaKind: "video",
        filename: "stitched-ws.mp4",
      },
      postprocessError: null,
      importedAssetIds: ["asset-packaged-ws"],
    });
  });

  it("imports a single websocket-only image output in auto mode", async () => {
    const previewFrame = new File(["frame-1"], "ws_0001.png", {
      type: "image/png",
    });
    mockAddLocalAsset.mockResolvedValue({ id: "asset-frame-only-auto" });

    const result = await frontendPostprocess(
      [],
      {
        postprocessing: {
          mode: "auto",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: [previewFrame],
      },
    );

    expect(mockFetchOutputAsFile).not.toHaveBeenCalled();
    expect(mockPackageFramesAndAudioToVideo).not.toHaveBeenCalled();
    expect(mockAddLocalAsset).toHaveBeenCalledTimes(1);
    expect(mockAddLocalAsset).toHaveBeenCalledWith(
      previewFrame,
      makeGenerationMetadata(),
    );
    expect(result).toEqual({
      postprocessedPreview: null,
      postprocessError: null,
      importedAssetIds: ["asset-frame-only-auto"],
    });
  });

  it("returns websocket PNG with message when only one frame is available", async () => {
    const previewFrame = new File(["frame-1"], "ws_0001.png", {
      type: "image/png",
    });
    mockAddLocalAsset.mockResolvedValue({ id: "asset-frame-only-ws" });

    const result = await frontendPostprocess(
      [],
      {
        postprocessing: {
          mode: "stitch_frames_with_audio",
          panel_preview: "replace_outputs",
          on_failure: "show_error",
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: [previewFrame],
      },
    );

    expect(mockPackageFramesAndAudioToVideo).not.toHaveBeenCalled();
    expect(mockAddLocalAsset).toHaveBeenCalledTimes(1);
    expect(mockAddLocalAsset).toHaveBeenCalledWith(
      previewFrame,
      makeGenerationMetadata(),
    );
    expect(result).toEqual({
      postprocessedPreview: {
        previewUrl: "blob:postprocessed-preview",
        mediaKind: "image",
        filename: "ws_0001.png",
      },
      postprocessError:
        "Only one frame was generated; returning the PNG output.",
      importedAssetIds: ["asset-frame-only-ws"],
    });
  });

  it("returns raw outputs plus a stitch warning when fallback packaging fails", async () => {
    const frameOne = new File(["frame-1"], "frame_0001.png", {
      type: "image/png",
    });
    const frameTwo = new File(["frame-2"], "frame_0002.png", {
      type: "image/png",
    });
    const audio = new File(["audio"], "sound.wav", { type: "audio/wav" });

    mockFetchOutputAsFile
      .mockResolvedValueOnce(frameOne)
      .mockResolvedValueOnce(frameTwo)
      .mockResolvedValueOnce(audio);
    mockPackageFramesAndAudioToVideo.mockRejectedValue(
      new Error("muxer exploded"),
    );
    mockAddLocalAsset
      .mockResolvedValueOnce({ id: "asset-frame-1" })
      .mockResolvedValueOnce({ id: "asset-frame-2" })
      .mockResolvedValueOnce({ id: "asset-audio" });

    const result = await frontendPostprocess(
      [
        {
          filename: "frame_0001.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame-1",
        },
        {
          filename: "frame_0002.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame-2",
        },
        {
          filename: "sound.wav",
          subfolder: "",
          type: "output",
          viewUrl: "/sound",
        },
      ],
      {
        postprocessing: {
          mode: "stitch_frames_with_audio",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
          stitch_fps: 12,
        },
        aspectRatioProcessing: null,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockPackageFramesAndAudioToVideo).toHaveBeenCalledWith(
      [frameOne, frameTwo],
      audio,
      12,
    );
    expect(mockAddLocalAsset).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      postprocessedPreview: null,
      postprocessError:
        "Postprocessing failed while stitching frames+audio: muxer exploded",
      importedAssetIds: ["asset-frame-1", "asset-frame-2", "asset-audio"],
    });
  });

  it("reuses an existing compatible family when the request key matches a previous generation", async () => {
    const requestKey = "generation-family-request:v1:matching";
    const existingMatchKey = await buildGenerationFamilyAutoMatchKey(requestKey, {
      assetType: "image",
      durationMs: 5000,
      fpsMilli: null,
    });
    const existingFamily: AssetFamily = {
      id: "existing-family",
      representativeAssetId: "existing-asset",
      autoMatchKeys: [existingMatchKey!],
      compatibility: {
        assetType: "image",
        durationMs: 5000,
        fpsMilli: null,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const output = new File(["frame"], "output.png", {
      type: "image/png",
    });

    mockFetchOutputAsFile.mockResolvedValue(output);
    mockGetFamilies.mockReturnValue([existingFamily]);
    mockAddLocalAssetWithFamily.mockResolvedValue({ id: "asset-family-match" });

    await frontendPostprocess(
      [
        {
          filename: "output.png",
          subfolder: "",
          type: "output",
          viewUrl: "/output.png",
        },
      ],
      {
        postprocessing: {
          mode: "none",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
        },
        aspectRatioProcessing: null,
        autoFamilyRequestKey: requestKey,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockAddLocalAssetWithFamily).toHaveBeenCalledWith(
      output,
      makeGenerationMetadata(),
      expect.objectContaining({
        id: "existing-family",
        compatibility: {
          assetType: "image",
          durationMs: 5000,
          fpsMilli: null,
        },
      }),
      {
        assetType: "image",
        durationMs: 5000,
        fpsMilli: null,
      },
    );
    expect(mockUpsertFamily).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "existing-family",
        representativeAssetId: "asset-family-match",
      }),
    );
  });

  it("creates and then reuses the same auto-family across separate postprocess runs", async () => {
    const requestKey = "generation-family-request:v1:new-family";
    const createdFamilies: AssetFamily[] = [];
    const firstOutput = new File(["frame-1"], "output-1.png", {
      type: "image/png",
    });
    const secondOutput = new File(["frame-2"], "output-2.png", {
      type: "image/png",
    });

    mockGetFamilies.mockImplementation(() => [...createdFamilies]);
    mockFetchOutputAsFile
      .mockResolvedValueOnce(firstOutput)
      .mockResolvedValueOnce(secondOutput);
    mockAddLocalAssetWithFamily.mockResolvedValueOnce({ id: "asset-family-1" });
    mockAddLocalAssetWithFamily.mockResolvedValueOnce({ id: "asset-family-2" });
    mockUpsertFamily.mockImplementation(async (family) => {
      createdFamilies.splice(0, createdFamilies.length, family);
    });

    await frontendPostprocess(
      [
        {
          filename: "output-1.png",
          subfolder: "",
          type: "output",
          viewUrl: "/output-1.png",
        },
      ],
      {
        postprocessing: {
          mode: "none",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
        },
        aspectRatioProcessing: null,
        autoFamilyRequestKey: requestKey,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockAddLocalAssetWithFamily).toHaveBeenCalledTimes(1);
    const createdFamily = createdFamilies[0];
    expect(createdFamily).toBeDefined();
    expect(createdFamily?.representativeAssetId).toBe("asset-family-1");

    await frontendPostprocess(
      [
        {
          filename: "output-2.png",
          subfolder: "",
          type: "output",
          viewUrl: "/output-2.png",
        },
      ],
      {
        postprocessing: {
          mode: "none",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
        },
        aspectRatioProcessing: null,
        autoFamilyRequestKey: requestKey,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockAddLocalAssetWithFamily).toHaveBeenLastCalledWith(
      secondOutput,
      makeGenerationMetadata(),
      expect.objectContaining({
        id: createdFamily?.id,
      }),
      {
        assetType: "image",
        durationMs: 5000,
        fpsMilli: null,
      },
    );
  });

  it("creates an auto-family for stitched videos from deterministic compatibility", async () => {
    const requestKey = "generation-family-request:v1:partial-family";
    const frameOne = new File(["frame-1"], "frame_0001.png", {
      type: "image/png",
    });
    const frameTwo = new File(["frame-2"], "frame_0002.png", {
      type: "image/png",
    });
    const output = new File(["video"], "output.mp4", {
      type: "video/mp4",
    });

    mockFetchOutputAsFile
      .mockResolvedValueOnce(frameOne)
      .mockResolvedValueOnce(frameTwo);
    mockPackageFramesAndAudioToVideo.mockResolvedValue({
      file: output,
      compatibility: {
        assetType: "video",
        durationMs: 167,
        fpsMilli: 12000,
      },
    });
    mockAddLocalAssetWithFamily.mockResolvedValue({ id: "asset-partial-family" });

    await frontendPostprocess(
      [
        {
          filename: "frame_0001.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame_0001.png",
        },
        {
          filename: "frame_0002.png",
          subfolder: "",
          type: "output",
          viewUrl: "/frame_0002.png",
        },
      ],
      {
        postprocessing: {
          mode: "stitch_frames_with_audio",
          panel_preview: "raw_outputs",
          on_failure: "fallback_raw",
          stitch_fps: 12,
        },
        aspectRatioProcessing: null,
        autoFamilyRequestKey: requestKey,
        generationMetadata: makeGenerationMetadata(),
        previewFrameFiles: null,
      },
    );

    expect(mockAddLocalAssetWithFamily).toHaveBeenCalledWith(
      output,
      makeGenerationMetadata(),
      expect.objectContaining({
        compatibility: {
          assetType: "video",
          durationMs: 167,
          fpsMilli: 12000,
        },
      }),
      {
        assetType: "video",
        durationMs: 167,
        fpsMilli: 12000,
      },
    );
    expect(mockInspectAssetFamilyCompatibility).not.toHaveBeenCalled();
    expect(mockUpsertFamily).toHaveBeenCalledWith(
      expect.objectContaining({
        representativeAssetId: "asset-partial-family",
      }),
    );
  });
});
