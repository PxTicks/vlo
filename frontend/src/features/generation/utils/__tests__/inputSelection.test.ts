import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportRenderer } from "../../../renderer";
import { useProjectStore } from "../../../project/useProjectStore";
import { useTimelineStore } from "../../../timeline";
import { useAssetStore } from "../../../userAssets";
import { renderTimelineSelectionToWebmWithMask } from "../inputSelection";

describe("inputSelection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    useProjectStore.setState({
      config: {
        aspectRatio: "16:9",
        fps: 24,
        layoutMode: "compact",
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
          clipComponents: [
            {
              clipId: "clip_1::mask::mask_1",
              componentType: "mask",
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

  it("renders remove_transparency as a separate maskless video pass", async () => {
    const renderSpy = vi
      .fn()
      .mockResolvedValueOnce({
        video: new Blob(["mask"], { type: "video/webm" }),
        outputs: {
          mask: new Blob(["mask"], { type: "video/webm" }),
        },
      })
      .mockResolvedValueOnce({
        video: new Blob(["video"], { type: "video/webm" }),
        outputs: {
          video: new Blob(["video"], { type: "video/webm" }),
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

    const result = await renderTimelineSelectionToWebmWithMask(
      timelineSelection,
      "binary",
      {
        videoTreatment: "remove_transparency",
      },
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
      preserveAlpha: false,
    });

    expect(result.video.type).toBe("video/webm");
    expect(result.mask.type).toBe("video/webm");
  });
});
