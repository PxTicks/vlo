import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportRenderer } from "../../../renderer";
import { useProjectStore } from "../../../project/useProjectStore";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { useAssetStore } from "../../../userAssets";
import {
  captureFramePngAtTick,
  DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS,
  getDerivedMaskRenderKey,
  pickPrimaryPreparedMaskFile,
  renderAssetToMaskMp4,
  renderTimelineSelectionToFrameBatch,
  renderTimelineSelectionToMaskMp4,
  renderTimelineSelectionToMp4,
  renderTimelineSelectionToMp4WithDerivedMasks,
  renderTimelineSelectionToMp4WithMask,
  resolveAudioTimingMaskExportFps,
} from "../inputSelection";

describe("inputSelection", () => {
  const SMALL_MASK_OUTPUT_SIZE = 64;

  beforeEach(() => {
    vi.restoreAllMocks();

    useProjectStore.setState({
      config: {
        aspectRatio: "16:9",
        outputResolution: 1080,
        fps: 24,
        fitMode: "cover",
        layoutMode: "compact",
        assetBrowserDisplay: "grouped",
      },
    });
    useTimelineStore.setState({
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
          type: "visual",
        },
      ],
      clips: [
        {
          id: "clip_1",
          trackId: "track_1",
          type: "video",
          name: "Clip",
          assetId: "asset_1",
          start: 0,
          timelineDuration: 24,
          offset: 0,
          components: [
            {
              id: "mask_ref_1",
              type: "mask_ref",
              parameters: { maskClipId: "clip_1::mask::mask_1" },
            },
          ],
        },
        {
          id: "clip_1::mask::mask_1",
          trackId: "track_1",
          type: "mask",
          name: "Mask",
          parentClipId: "clip_1",
          start: 0,
          timelineDuration: 24,
          offset: 0,
          maskMode: "apply",
          maskType: "rectangle",
        },
      ] as never,
    });
    useAssetStore.setState({
      assets: [
        {
          id: "asset_1",
          src: "blob:asset-1",
          name: "asset.mp4",
          hash: "hash-1",
          type: "video",
          createdAt: 0,
        },
      ],
    });
  });

  it("renders derived masks as a separate maskless video pass", async () => {
    const renderSpy = vi
      .fn()
      .mockResolvedValueOnce({
        video: new Blob(["mask"], { type: "video/mp4" }),
        outputs: {
          mask: new Blob(["mask"], { type: "video/mp4" }),
        },
        outputAnalyses: {
          mask: {
            hasVisibleContent: false,
          },
        },
      })
      .mockResolvedValueOnce({
        video: new Blob(["video"], { type: "video/mp4" }),
        outputs: {
          video: new Blob(["video"], { type: "video/mp4" }),
        },
      });
    const createSpy = vi
      .spyOn(ExportRenderer, "create")
      .mockResolvedValue({ render: renderSpy } as unknown as ExportRenderer);

    const timelineSelection = {
      start: 0,
      end: 24,
      clips: useTimelineStore.getState().clips,
      fps: 24,
    };

    const result = await renderTimelineSelectionToMp4WithMask(
      timelineSelection,
      "binary",
    );

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(renderSpy).toHaveBeenCalledTimes(2);

    const maskRenderOptions = renderSpy.mock.calls[0][3];
    expect(maskRenderOptions?.outputs).toHaveLength(1);
    expect(maskRenderOptions?.outputs?.[0]?.id).toBe("mask");
    expect(maskRenderOptions?.includeTimelineMasks).toBeUndefined();

    const videoRenderOptions = renderSpy.mock.calls[1][3];
    expect(videoRenderOptions).toMatchObject({
      includeTimelineMasks: false,
    });
    expect(videoRenderOptions?.outputs).toHaveLength(1);
    expect(videoRenderOptions?.outputs?.[0]).toMatchObject({
      id: "video",
      includeAudio: true,
    });

    expect(result.video.type).toBe("video/mp4");
    expect(result.mask.type).toBe("video/mp4");
    expect(result.maskHasVisibleContent).toBe(false);
  });

  it("renders mask-only outputs at explicit small dimensions when requested", async () => {
    const renderSpy = vi.fn().mockResolvedValue({
      video: new Blob(["mask"], { type: "video/mp4" }),
      outputs: {
        mask: new Blob(["mask"], { type: "video/mp4" }),
      },
    });
    const createSpy = vi
      .spyOn(ExportRenderer, "create")
      .mockResolvedValue({ render: renderSpy } as unknown as ExportRenderer);

    const timelineSelection = {
      start: 0,
      end: 24,
      clips: useTimelineStore.getState().clips,
      fps: 25,
    };

    const result = await renderTimelineSelectionToMaskMp4(
      timelineSelection,
      "binary",
      {
        outputWidth: SMALL_MASK_OUTPUT_SIZE,
        outputHeight: SMALL_MASK_OUTPUT_SIZE,
      },
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        outputWidth: SMALL_MASK_OUTPUT_SIZE,
        outputHeight: SMALL_MASK_OUTPUT_SIZE,
      }),
    );
    expect(renderSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outputWidth: SMALL_MASK_OUTPUT_SIZE,
        outputHeight: SMALL_MASK_OUTPUT_SIZE,
      }),
      expect.any(Function),
      expect.objectContaining({
        outputs: [expect.objectContaining({ id: "mask" })],
      }),
    );
    expect(result.type).toBe("video/mp4");
  });

  it("does not recover referenced mask clips from the live timeline", async () => {
    const renderSpy = vi.fn().mockResolvedValue({
      video: new Blob(["mask"], { type: "video/mp4" }),
      outputs: {
        mask: new Blob(["mask"], { type: "video/mp4" }),
      },
    });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);

    const [visualClip] = useTimelineStore.getState().clips;
    const timelineSelection = {
      start: 0,
      end: 24,
      clips: [visualClip],
      fps: 24,
    };

    await renderTimelineSelectionToMaskMp4(timelineSelection, "binary");

    expect(
      renderSpy.mock.calls[0]?.[3]?.timelineSelection?.clips?.map(
        (clip: { id: string }) => clip.id,
      ),
    ).toEqual(["clip_1"]);
  });

  it("uses the configured audio timing mask fps and defaults to 25 when omitted", async () => {
    const renderSpy = vi.fn().mockResolvedValue({
      video: new Blob(["video"], { type: "video/mp4" }),
      outputs: {
        video: new Blob(["video"], { type: "video/mp4" }),
        mask: new Blob(["mask"], { type: "video/mp4" }),
      },
    });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);

    const timelineSelection = {
      start: 0,
      end: 24,
      clips: useTimelineStore.getState().clips,
      fps: 24,
    };

    await renderTimelineSelectionToMp4WithDerivedMasks(timelineSelection, [
      {
        maskType: "binary",
        purpose: "audio_timing",
        renderFps: 17,
      },
    ]);

    await renderTimelineSelectionToMp4WithDerivedMasks(timelineSelection, [
      {
        maskType: "binary",
        purpose: "audio_timing",
      },
    ]);

    expect(renderSpy.mock.calls[1]?.[3]).toMatchObject({
      timelineSelection: expect.objectContaining({ fps: 17 }),
    });
    expect(renderSpy.mock.calls[1]?.[1]).toMatchObject({
      outputWidth: renderSpy.mock.calls[0]?.[1]?.outputWidth,
      outputHeight: renderSpy.mock.calls[0]?.[1]?.outputHeight,
    });
    expect(renderSpy.mock.calls[3]?.[3]).toMatchObject({
      timelineSelection: expect.objectContaining({
        fps: DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS,
      }),
    });
    expect(renderSpy.mock.calls[3]?.[1]).toMatchObject({
      outputWidth: renderSpy.mock.calls[2]?.[1]?.outputWidth,
      outputHeight: renderSpy.mock.calls[2]?.[1]?.outputHeight,
    });
  });

  it("renders the source video from the full selection while keeping masks on included tracks when requested", async () => {
    const renderSpy = vi
      .fn()
      .mockResolvedValueOnce({
        video: new Blob(["video"], { type: "video/mp4" }),
        outputs: {
          video: new Blob(["video"], { type: "video/mp4" }),
        },
      })
      .mockResolvedValueOnce({
        video: new Blob(["mask"], { type: "video/mp4" }),
        outputs: {
          mask: new Blob(["mask"], { type: "video/mp4" }),
        },
        outputAnalyses: {
          mask: {
            hasVisibleContent: true,
          },
        },
      });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);

    const timelineSelection = {
      start: 0,
      end: 24,
      clips: useTimelineStore.getState().clips,
      fps: 24,
      includedTrackIds: ["track_1"],
    };

    await renderTimelineSelectionToMp4WithDerivedMasks(timelineSelection, [
      {
        maskType: "binary",
        purpose: "video",
        sourceSelection: "full_selection",
        maskSelection: "input_selection",
        sourceVideoTreatment: "preserve_transparency",
      },
    ]);

    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(renderSpy.mock.calls[0]?.[3]?.includeTimelineMasks).toBeUndefined();
    expect(
      renderSpy.mock.calls[0]?.[3]?.timelineSelection?.includedTrackIds,
    ).toBeUndefined();
    expect(
      renderSpy.mock.calls[1]?.[3]?.timelineSelection?.includedTrackIds,
    ).toEqual(["track_1"]);
  });

  it("resolves mask keys, FPS defaults, and primary visual masks", () => {
    expect(resolveAudioTimingMaskExportFps(12.6)).toBe(13);
    expect(resolveAudioTimingMaskExportFps(0)).toBe(
      DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS,
    );
    expect(resolveAudioTimingMaskExportFps(Number.NaN)).toBe(
      DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS,
    );
    expect(
      getDerivedMaskRenderKey({ maskType: "soft", purpose: "video" }),
    ).toBe("video_soft");
    expect(
      getDerivedMaskRenderKey({ maskType: "binary", purpose: "video" }),
    ).toBe("video_binary");
    expect(
      getDerivedMaskRenderKey({
        maskType: "soft",
        purpose: "audio_timing",
        renderFps: 10,
      }),
    ).toBe("audio_timing_binary_10");

    const binary = new File(["mask"], "binary.mp4");
    expect(
      pickPrimaryPreparedMaskFile(
        [
          { maskType: "binary", purpose: "audio_timing" },
          { maskType: "binary", purpose: "video" },
        ],
        { video_binary: binary },
      ),
    ).toBe(binary);
    expect(
      pickPrimaryPreparedMaskFile(
        [{ maskType: "binary", purpose: "audio_timing" }],
        {},
      ),
    ).toBeNull();
  });

  it("captures a PNG frame with timeline selection context", async () => {
    const frame = new File(["png"], "frame.png", { type: "image/png" });
    const rendererModule = await import("../../../renderer");
    const captureSpy = vi
      .spyOn(rendererModule, "renderProjectFrameFileAtTick")
      .mockResolvedValue(frame);
    const selection = {
      start: 0,
      end: 24,
      clips: [],
    };

    await expect(
      captureFramePngAtTick(12, "preview", selection),
    ).resolves.toBe(frame);
    expect(captureSpy).toHaveBeenCalledWith(12, {
      filenamePrefix: "preview",
      mimeType: "image/png",
      timelineSelection: selection,
    });
  });

  it("renders a selection MP4 and rejects blank strict render health", async () => {
    const rendererModule = await import("../../../renderer");
    const file = new File(["video"], "selection.mp4");
    const renderSpy = vi
      .spyOn(rendererModule, "renderSelectionToVideoFile")
      .mockImplementation(async (_selection, options) => {
        options?.onRenderHealth?.({
          totals: {
            replies: 3,
            nullFrames: 3,
            missingRendererFrames: 2,
            errorFrames: 1,
          },
        } as never);
        return file;
      });

    await expect(
      renderTimelineSelectionToMp4({
        start: 0,
        end: 24,
        clips: [],
      }),
    ).rejects.toThrow(/contained no decoded frames/);
    expect(renderSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filenamePrefix: "generation-selection",
      }),
    );
  });

  it("warns for degraded but usable selection renders", async () => {
    const rendererModule = await import("../../../renderer");
    const file = new File(["video"], "selection.mp4");
    vi.spyOn(rendererModule, "renderSelectionToVideoFile").mockImplementation(
      async (_selection, options) => {
        options?.onRenderHealth?.({
          totals: {
            replies: 3,
            nullFrames: 1,
            missingRendererFrames: 0,
            errorFrames: 1,
          },
        } as never);
        return file;
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      renderTimelineSelectionToMp4({
        start: 0,
        end: 24,
        clips: [],
      }),
    ).resolves.toBe(file);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("degraded frames"),
      expect.anything(),
    );
  });

  it("normalizes render failures to abort errors when cancellation wins", async () => {
    const rendererModule = await import("../../../renderer");
    const controller = new AbortController();
    vi.spyOn(rendererModule, "renderSelectionToVideoFile").mockImplementation(
      async () => {
        controller.abort();
        throw new Error("renderer stopped");
      },
    );

    await expect(
      renderTimelineSelectionToMp4(
        { start: 0, end: 24, clips: [] },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses one renderer for transparency-preserving video and mask output", async () => {
    const renderSpy = vi.fn().mockResolvedValue({
      outputs: {
        video: new Blob(["video"]),
        mask: new Blob(["mask"]),
      },
      outputAnalyses: {
        mask: { hasVisibleContent: false },
      },
    });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);

    const result = await renderTimelineSelectionToMp4WithMask(
      {
        start: 0,
        end: 24,
        clips: useTimelineStore.getState().clips,
      },
      "soft",
      {
        sourceVideoTreatment: "preserve_transparency",
        outputWidth: 640,
        outputHeight: 384,
      },
    );

    expect(ExportRenderer.create).toHaveBeenCalledWith(
      expect.objectContaining({ outputWidth: 640, outputHeight: 384 }),
    );
    expect(renderSpy).toHaveBeenCalledOnce();
    expect(renderSpy.mock.calls[0][3]?.outputs).toEqual([
      expect.objectContaining({
        id: "video",
        transformStack: expect.arrayContaining([expect.any(Function)]),
      }),
      expect.objectContaining({ id: "mask", contentProbe: "non_black_pixels" }),
    ]);
    expect(result.maskHasVisibleContent).toBe(false);
  });

  it("rejects missing requested video or mask outputs", async () => {
    const renderSpy = vi
      .fn()
      .mockResolvedValueOnce({ outputs: { mask: new Blob(["mask"]) } })
      .mockResolvedValueOnce({ outputs: { video: new Blob(["video"]) } });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);
    const selection = {
      start: 0,
      end: 24,
      clips: useTimelineStore.getState().clips,
    };

    await expect(
      renderTimelineSelectionToMp4WithMask(selection, "binary", {
        sourceVideoTreatment: "preserve_transparency",
      }),
    ).rejects.toThrow("Video output was requested but not produced");
    await expect(
      renderTimelineSelectionToMp4WithMask(selection, "binary", {
        sourceVideoTreatment: "preserve_transparency",
      }),
    ).rejects.toThrow("Mask output was requested but not produced");
  });

  it("reuses prepared video and visual mask files", async () => {
    const preparedVideo = new File(["video"], "prepared.mp4");
    const preparedMask = new File(["mask"], "prepared-mask.mp4");
    const createSpy = vi.spyOn(ExportRenderer, "create");

    const result = await renderTimelineSelectionToMp4WithDerivedMasks(
      {
        start: 0,
        end: 24,
        clips: useTimelineStore.getState().clips,
      },
      [{ maskType: "binary", purpose: "video" }],
      {
        preparedVideoFile: preparedVideo,
        preparedMaskFile: preparedMask,
      },
    );

    expect(result).toEqual({
      video: preparedVideo,
      masks: { video_binary: preparedMask },
      maskContentByKey: { video_binary: true },
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects conflicting source selection modes and video treatments", async () => {
    const selection = {
      start: 0,
      end: 24,
      clips: useTimelineStore.getState().clips,
    };
    await expect(
      renderTimelineSelectionToMp4WithDerivedMasks(selection, [
        {
          maskType: "binary",
          purpose: "video",
          sourceSelection: "full_selection",
        },
        {
          maskType: "soft",
          purpose: "video",
          sourceSelection: "input_selection",
        },
      ]),
    ).rejects.toThrow("conflicting source selection modes");
    await expect(
      renderTimelineSelectionToMp4WithDerivedMasks(selection, [
        {
          maskType: "binary",
          purpose: "video",
          sourceVideoTreatment: "preserve_transparency",
        },
        {
          maskType: "soft",
          purpose: "video",
          sourceVideoTreatment: "remove_transparency",
        },
      ]),
    ).rejects.toThrow("conflicting source video treatments");
  });

  it("renders multiple unique derived masks and deduplicates equal keys", async () => {
    const renderSpy = vi
      .fn()
      .mockResolvedValueOnce({ outputs: { video: new Blob(["video"]) } })
      .mockResolvedValue({
        outputs: { mask: new Blob(["mask"]) },
        outputAnalyses: { mask: { hasVisibleContent: true } },
      });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);
    const selection = {
      start: 0,
      end: 24,
      clips: useTimelineStore.getState().clips,
    };

    const result = await renderTimelineSelectionToMp4WithDerivedMasks(
      selection,
      [
        { maskType: "binary", purpose: "video", optional: true },
        { maskType: "binary", purpose: "video" },
        { maskType: "soft", purpose: "video" },
        { maskType: "binary", purpose: "audio_timing", renderFps: 12 },
      ],
    );

    expect(Object.keys(result.masks).sort()).toEqual([
      "audio_timing_binary_12",
      "video_binary",
      "video_soft",
    ]);
    expect(renderSpy).toHaveBeenCalledTimes(4);
  });

  it("validates assets before rendering transparency masks", async () => {
    await expect(renderAssetToMaskMp4("missing")).rejects.toThrow(
      "not found",
    );
    useAssetStore.setState({
      assets: [
        {
          id: "audio",
          name: "audio.wav",
          type: "audio",
          src: "blob:audio",
          hash: "audio",
          createdAt: 0,
        },
      ],
    });
    await expect(renderAssetToMaskMp4("audio")).rejects.toThrow(
      "Cannot derive a transparency mask from audio",
    );
    useAssetStore.setState({
      assets: [
        {
          id: "lut",
          name: "look.cube",
          type: "lut",
          src: "blob:lut",
          hash: "lut",
          createdAt: 0,
        },
      ],
    });
    await expect(renderAssetToMaskMp4("lut")).rejects.toThrow(
      "Cannot derive a transparency mask from lut",
    );
  });

  it("renders image transparency masks with a synthetic one-frame project", async () => {
    const renderSpy = vi.fn().mockResolvedValue({
      outputs: { mask: new Blob(["mask"]) },
      outputAnalyses: { mask: { hasVisibleContent: true } },
    });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);
    useAssetStore.setState({
      assets: [
        {
          id: "image",
          name: "image.png",
          type: "image",
          src: "blob:image",
          hash: "image",
          createdAt: 0,
        },
      ],
      getInput: vi.fn(async () => ({
        getPrimaryVideoTrack: vi.fn(async () => ({
          displayWidth: 321,
          displayHeight: 123,
        })),
      })) as never,
    });

    const result = await renderAssetToMaskMp4("image", {
      maskType: "soft",
    });
    expect(ExportRenderer.create).toHaveBeenCalledWith({
      logicalWidth: 321,
      logicalHeight: 123,
      outputWidth: 321,
      outputHeight: 123,
      backgroundAlpha: 0,
    });
    expect(renderSpy.mock.calls[0][0]).toMatchObject({
      duration: 96000,
      fps: 1,
    });
    expect(result.hasVisibleContent).toBe(true);
  });

  it("validates video tracks, dimensions, and duration probing", async () => {
    const videoAsset = {
      id: "video",
      name: "video.mp4",
      type: "video" as const,
      src: "blob:video",
      hash: "video",
      createdAt: 0,
    };
    useAssetStore.setState({
      assets: [videoAsset],
      getInput: vi.fn(async () => null) as never,
    });
    await expect(renderAssetToMaskMp4("video")).rejects.toThrow(
      "Failed to load asset input",
    );

    useAssetStore.setState({
      getInput: vi.fn(async () => ({
        getPrimaryVideoTrack: vi.fn(async () => null),
      })) as never,
    });
    await expect(renderAssetToMaskMp4("video")).rejects.toThrow(
      "has no video track",
    );

    useAssetStore.setState({
      getInput: vi.fn(async () => ({
        getPrimaryVideoTrack: vi.fn(async () => ({
          displayWidth: 0,
          displayHeight: 100,
        })),
      })) as never,
    });
    await expect(renderAssetToMaskMp4("video")).rejects.toThrow(
      "invalid display dimensions",
    );

    useAssetStore.setState({
      getInput: vi.fn(async () => ({
        getPrimaryVideoTrack: vi.fn(async () => ({
          displayWidth: 100,
          displayHeight: 100,
          computeDuration: vi.fn(async () => 0),
          computePacketStats: vi.fn(async () => null),
        })),
        computeDuration: vi.fn(async () => 0),
      })) as never,
    });
    await expect(renderAssetToMaskMp4("video")).rejects.toThrow(
      "Could not determine duration",
    );
  });

  it("falls back from track duration and packet FPS when rendering video assets", async () => {
    const renderSpy = vi.fn().mockResolvedValue({
      outputs: { mask: new Blob(["mask"]) },
    });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);
    useAssetStore.setState({
      assets: [
        {
          id: "video",
          name: "video.mp4",
          type: "video",
          src: "blob:video",
          hash: "video",
          fps: 30,
          createdAt: 0,
        },
      ],
      getInput: vi.fn(async () => ({
        getPrimaryVideoTrack: vi.fn(async () => ({
          displayWidth: 100,
          displayHeight: 50,
          computeDuration: vi.fn(async () => {
            throw new Error("probe failed");
          }),
          computePacketStats: vi.fn(async () => {
            throw new Error("stats failed");
          }),
        })),
        computeDuration: vi.fn(async () => 2),
      })) as never,
    });

    await renderAssetToMaskMp4("video");
    expect(renderSpy.mock.calls[0][0]).toMatchObject({
      duration: 192000,
      fps: 30,
    });
  });

  it("rejects missing asset mask output and converts cancellation", async () => {
    const controller = new AbortController();
    const renderSpy = vi.fn(async () => {
      controller.abort();
      throw new Error("cancelled render");
    });
    vi.spyOn(ExportRenderer, "create").mockResolvedValue({
      render: renderSpy,
    } as unknown as ExportRenderer);
    useAssetStore.setState({
      assets: [
        {
          id: "image",
          name: "image.png",
          type: "image",
          src: "blob:image",
          hash: "image",
          createdAt: 0,
        },
      ],
      getInput: vi.fn(async () => ({
        getPrimaryVideoTrack: vi.fn(async () => ({
          displayWidth: 100,
          displayHeight: 100,
        })),
      })) as never,
    });
    await expect(
      renderAssetToMaskMp4("image", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("renders a snapped frame batch with limits", async () => {
    const rendererModule = await import("../../../renderer");
    const captureSpy = vi
      .spyOn(rendererModule, "renderProjectFrameFileAtTick")
      .mockImplementation(async (tick) =>
        new File(["png"], `frame-${tick}.png`),
      );
    const selection = {
      start: 0,
      end: 96000,
      clips: [],
      fps: 24,
      frameStep: 4,
    };

    const frames = await renderTimelineSelectionToFrameBatch(selection, 30, {
      maxFrames: 10,
    });
    expect(frames).toHaveLength(9);
    expect(captureSpy).toHaveBeenCalledTimes(9);
  });
});
