import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportRenderer } from "../../../renderer";
import { useProjectStore } from "../../../project/useProjectStore";
import { useTimelineStore } from "../../../timeline";
import { useAssetStore } from "../../../userAssets";
import {
  DEFAULT_AUDIO_TIMING_MASK_EXPORT_FPS,
  renderTimelineSelectionToMaskMp4,
  renderTimelineSelectionToMp4WithDerivedMasks,
  renderTimelineSelectionToMp4WithMask,
} from "../inputSelection";

describe("inputSelection", () => {
  const SMALL_MASK_OUTPUT_SIZE = 64;

  beforeEach(() => {
    vi.restoreAllMocks();

    useProjectStore.setState({
      config: {
        aspectRatio: "16:9",
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

  it("recovers referenced mask clips before rendering a mask output", async () => {
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
    ).toEqual(["clip_1", "clip_1::mask::mask_1"]);
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
});
