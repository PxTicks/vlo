import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedCreationMetadata } from "../../../../types/Asset";
import { useProjectStore } from "../../../project";
import { DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT } from "../../derivedMaskVideoTreatment";
import * as inputSelection from "../../utils/inputSelection";
import * as mediaUtils from "../../pipeline/utils/media";

const {
  mockAddLocalAsset,
  mockFetchOutputAsFile,
  mockPackageFramesAndAudioToVideo,
} = vi.hoisted(() => ({
  mockAddLocalAsset: vi.fn(),
  mockFetchOutputAsFile: vi.fn(),
  mockPackageFramesAndAudioToVideo: vi.fn(),
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
  getAssetById: vi.fn(() => undefined),
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
    mockFetchOutputAsFile.mockReset();
    mockPackageFramesAndAudioToVideo.mockReset();
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
    expect(request.targetResolution).toBe(720);
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

  it("forwards derived-mask video treatment into the selection renderer", async () => {
    const renderSpy = vi
      .spyOn(inputSelection, "renderTimelineSelectionToWebmWithMask")
      .mockResolvedValue({
        video: new File(["video"], "selection.webm", { type: "video/webm" }),
        mask: new File(["mask"], "selection-mask.webm", {
          type: "video/webm",
        }),
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
          derivedMaskVideoTreatment: "fill_transparent_with_neutral_gray",
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
      "binary",
      {
        signal: undefined,
        videoTreatment: "fill_transparent_with_neutral_gray",
      },
    );
    expect(request.videoInputs.video_input.name).toBe("selection.webm");
    expect(request.videoInputs.mask_input.name).toBe("selection-mask.webm");
  });

  it("reuses cached derived-mask renders when the requested treatment still matches", async () => {
    const renderSpy = vi.spyOn(
      inputSelection,
      "renderTimelineSelectionToWebmWithMask",
    );
    const preparedVideoFile = new File(["video"], "prepared.webm", {
      type: "video/webm",
    });
    const preparedMaskFile = new File(["mask"], "prepared-mask.webm", {
      type: "video/webm",
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
          derivedMaskVideoTreatment:
            DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
          preparedDerivedMaskVideoTreatment:
            DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
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

  it("rejects non-image values for manual image slots", async () => {
    await expect(
      frontendPreprocess(
        {},
        "workflow.json",
        [
          {
            nodeId: "slot:image",
            classType: "ManualSlot",
            inputType: "image",
            param: "image",
            label: "Image Slot",
            currentValue: null,
            origin: "rule",
            dispatch: {
              kind: "manual_slot",
              slotId: "image_slot",
              slotInputType: "image",
            },
          },
        ],
        {
          "slot:image": {
            type: "video",
            file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
          },
        },
        "client-id",
      ),
    ).rejects.toThrow("Slot 'image_slot' expects an image input");
  });

  it("rejects non-video values for manual video slots", async () => {
    await expect(
      frontendPreprocess(
        {},
        "workflow.json",
        [
          {
            nodeId: "slot:video",
            classType: "ManualSlot",
            inputType: "video",
            param: "video",
            label: "Video Slot",
            currentValue: null,
            origin: "rule",
            dispatch: {
              kind: "manual_slot",
              slotId: "video_slot",
              slotInputType: "video",
            },
          },
        ],
        {
          "slot:video": {
            type: "image",
            file: new File(["image"], "frame.png", { type: "image/png" }),
          },
        },
        "client-id",
      ),
    ).rejects.toThrow("Slot 'video_slot' expects a video input");
  });

  it("rejects non-text values for manual text slots", async () => {
    await expect(
      frontendPreprocess(
        {},
        "workflow.json",
        [
          {
            nodeId: "slot:text",
            classType: "ManualSlot",
            inputType: "text",
            param: "text",
            label: "Text Slot",
            currentValue: null,
            origin: "rule",
            dispatch: {
              kind: "manual_slot",
              slotId: "text_slot",
              slotInputType: "text",
            },
          },
        ],
        {
          "slot:text": {
            type: "image",
            file: new File(["image"], "frame.png", { type: "image/png" }),
          },
        },
        "client-id",
      ),
    ).rejects.toThrow("Slot 'text_slot' expects text input");
  });

  it("forwards abort signals into timeline-selection render helpers", async () => {
    const renderSpy = vi
      .spyOn(inputSelection, "renderTimelineSelectionToWebm")
      .mockResolvedValue(
        new File(["video"], "selection.webm", { type: "video/webm" }),
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
    const renderSpy = vi.spyOn(inputSelection, "renderTimelineSelectionToWebm");
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
    const packagedVideo = new File(["video"], "stitched.webm", {
      type: "video/webm",
    });

    mockFetchOutputAsFile
      .mockResolvedValueOnce(frameOne)
      .mockResolvedValueOnce(frameTwo)
      .mockResolvedValueOnce(audio);
    mockPackageFramesAndAudioToVideo.mockResolvedValue(packagedVideo);
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
        filename: "stitched.webm",
      },
      postprocessError: null,
      importedAssetIds: ["asset-packaged"],
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
    const packagedVideo = new File(["video"], "stitched-silent.webm", {
      type: "video/webm",
    });

    mockFetchOutputAsFile
      .mockResolvedValueOnce(frameOne)
      .mockResolvedValueOnce(frameTwo);
    mockPackageFramesAndAudioToVideo.mockResolvedValue(packagedVideo);
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
        filename: "stitched-silent.webm",
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
    const packagedVideo = new File(["video"], "stitched-ws.webm", {
      type: "video/webm",
    });

    mockPackageFramesAndAudioToVideo.mockResolvedValue(packagedVideo);
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
        filename: "stitched-ws.webm",
      },
      postprocessError: null,
      importedAssetIds: ["asset-packaged-ws"],
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
});
