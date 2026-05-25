import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project/useProjectStore";
import { useTimelineStore } from "../useTimelineStore";

function createTimelineClip(
  overrides: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id: "clip_1",
    trackId: "track_1",
    type: "video",
    name: "Clip",
    assetId: "asset_1",
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

describe("useTimelineStore fit mode defaults", () => {
  beforeEach(() => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        fitMode: "cover",
      },
    }));

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
          type: "visual",
        },
      ],
      clips: [],
    });
  });

  it("stamps the current project fit mode onto new visual clips", () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        fitMode: "contain",
      },
    }));

    useTimelineStore.getState().addClip(createTimelineClip());

    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({
        transformations: [
          expect.objectContaining({
            type: "fitMode",
            isEnabled: true,
            parameters: {
              fitMode: "contain",
            },
          }),
        ],
      }),
    ]);
  });

  it("preserves explicit clip fit mode transforms", () => {
    useProjectStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        fitMode: "contain",
      },
    }));

    useTimelineStore.getState().addClip(
      createTimelineClip({
        transformations: [
          {
            id: "fit_mode_override",
            type: "fitMode",
            isEnabled: true,
            parameters: {
              fitMode: "cover",
            },
          },
        ],
      }),
    );

    expect(useTimelineStore.getState().clips[0].transformations).toEqual([
      expect.objectContaining({
        type: "fitMode",
        parameters: {
          fitMode: "cover",
        },
      }),
    ]);
  });

  it("does not stamp fit mode onto audio clips", () => {
    useTimelineStore.getState().addClip(
      createTimelineClip({
        type: "audio",
        transformations: [],
      }),
    );

    expect(useTimelineStore.getState().clips[0].transformations).toEqual([]);
  });
});
