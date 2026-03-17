import { vi, describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { Application, Container, FederatedPointerEvent, Sprite } from "pixi.js";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import { useTimelineStore } from "../../../../timeline";
import { usePlayerStore } from "../../../usePlayerStore";
import { playbackClock } from "../../../services/PlaybackClock";
import { liveParamStore } from "../../../../transformations";
import { useTransformInteractionController } from "../useTransformInteractionController";

// Mock Pixi Application stage event bus only.
vi.mock("pixi.js", async () => {
  const originalModule = await vi.importActual("pixi.js");
  return {
    ...originalModule,
    Application: class MockApplication {
      stage = {
        on: vi.fn(),
        off: vi.fn(),
      };
      destroy = vi.fn();
    },
  };
});

describe("useTransformInteractionController", () => {
  let mockSprite: Sprite;
  let mockApp: Application;
  let mockViewport: Container;
  let activeClipRef: { current: TimelineClip | null };

  beforeEach(() => {
    useTimelineStore.setState({
      clips: [],
      tracks: [],
    });
    usePlayerStore.setState({ isPlaying: true });
    playbackClock.setTime(0);

    mockSprite = new Sprite();
    mockSprite.eventMode = "passive";

    mockApp = new Application();
    mockViewport = new Container();
    mockViewport.toLocal = vi.fn((point: { x: number; y: number }) => ({
      x: point.x,
      y: point.y,
    })) as unknown as Container["toLocal"];
  });

  const getStageHandler = (eventName: string) =>
    vi
      .mocked(mockApp.stage.on)
      .mock.calls.find((call) => call[0] === eventName)?.[1] as
      | ((e: FederatedPointerEvent) => void)
      | undefined;

  it("materializes position on first move for live updates, then commits on drop", () => {
    const clip: TimelineClip = {
      id: "clip_no_transforms",
      trackId: "track_1",
      type: "video",
      assetId: "asset_1",
      start: 0,
      timelineDuration: 100,
      offset: 0,
      transformedDuration: 100,
      transformedOffset: 0,
    } as TimelineClip;

    useTimelineStore.getState().addClip(clip);
    activeClipRef = { current: clip };

    const { result } = renderHook(() =>
      useTransformInteractionController(
        mockSprite,
        activeClipRef,
        mockApp,
        mockViewport,
      ),
    );

    act(() => {
      result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 50, y: 50 },
        originalEvent: { shiftKey: false, ctrlKey: false, metaKey: false },
      } as unknown as FederatedPointerEvent);
    });

    const onPointerMove = getStageHandler("pointermove");
    expect(onPointerMove).toBeDefined();
    const notifySpy = vi.spyOn(liveParamStore, "notify");

    act(() => {
      onPointerMove!(
        {
          global: { x: 80, y: 90 },
        } as unknown as FederatedPointerEvent,
      );
    });

    const clipsBeforeDrop = useTimelineStore.getState().clips;
    expect(clipsBeforeDrop[0].transformations?.length ?? 0).toBe(1);
    expect(clipsBeforeDrop[0].transformations[0].type).toBe("position");
    expect(clipsBeforeDrop[0].transformations[0].parameters.x).toBe(0);
    expect(clipsBeforeDrop[0].transformations[0].parameters.y).toBe(0);
    expect(notifySpy).toHaveBeenCalledWith(
      clipsBeforeDrop[0].transformations[0].id,
      "x",
      30,
    );
    expect(notifySpy).toHaveBeenCalledWith(
      clipsBeforeDrop[0].transformations[0].id,
      "y",
      40,
    );

    const onPointerUp = getStageHandler("pointerup");
    expect(onPointerUp).toBeDefined();

    act(() => {
      onPointerUp!(
        {
          global: { x: 80, y: 90 },
        } as unknown as FederatedPointerEvent,
      );
    });

    const clipsAfterDrop = useTimelineStore.getState().clips;
    expect(clipsAfterDrop[0].transformations).toBeDefined();
    expect(clipsAfterDrop[0].transformations.length).toBe(1);
    expect(clipsAfterDrop[0].transformations[0].parameters.x).toBe(30);
    expect(clipsAfterDrop[0].transformations[0].parameters.y).toBe(40);

    notifySpy.mockRestore();
  });

  it("selects the clip on sprite pointer down", () => {
    const clip: TimelineClip = {
      id: "clip_select_test",
      trackId: "track_1",
      type: "video",
      transformations: [],
      assetId: "test",
      start: 0,
      timelineDuration: 100,
      offset: 0,
      croppedSourceDuration: 100,
      transformedOffset: 0,
      sourceDuration: 100,
      transformedDuration: 100,
      name: "select test",
    } as TimelineClip;

    useTimelineStore.getState().addClip(clip);
    activeClipRef = { current: clip };

    const { result } = renderHook(() =>
      useTransformInteractionController(
        mockSprite,
        activeClipRef,
        mockApp,
        mockViewport,
      ),
    );

    act(() => {
      result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 50, y: 50 },
        originalEvent: { shiftKey: false, ctrlKey: false, metaKey: false },
      } as unknown as FederatedPointerEvent);
    });

    const selectedIds = useTimelineStore.getState().selectedClipIds;
    expect(selectedIds).toContain("clip_select_test");
  });

  it("keeps spline parameters and commits dragged value at playhead time", () => {
    playbackClock.setTime(50);
    const notifySpy = vi.spyOn(liveParamStore, "notify");

    const clip: TimelineClip = {
      id: "clip_spline_drag",
      trackId: "track_1",
      type: "video",
      assetId: "asset_1",
      start: 0,
      timelineDuration: 200,
      offset: 0,
      transformedDuration: 200,
      transformedOffset: 0,
      croppedSourceDuration: 200,
      sourceDuration: 200,
      name: "Spline Clip",
      transformations: [
        {
          id: "position_1",
          type: "position",
          isEnabled: true,
          parameters: {
            x: {
              type: "spline",
              points: [
                { time: 0, value: 0 },
                { time: 100, value: 100 },
              ],
            },
            y: {
              type: "spline",
              points: [
                { time: 0, value: 0 },
                { time: 100, value: 0 },
              ],
            },
          },
          keyframeTimes: [0, 100],
        },
      ],
    } as TimelineClip;

    useTimelineStore.getState().addClip(clip);
    activeClipRef = { current: clip };

    const { result } = renderHook(() =>
      useTransformInteractionController(
        mockSprite,
        activeClipRef,
        mockApp,
        mockViewport,
      ),
    );

    act(() => {
      result.current.onSpritePointerDown({
        button: 0,
        stopPropagation: vi.fn(),
        global: { x: 10, y: 10 },
        originalEvent: { shiftKey: false, ctrlKey: false, metaKey: false },
      } as unknown as FederatedPointerEvent);
    });

    const onPointerMove = getStageHandler("pointermove");
    expect(onPointerMove).toBeDefined();

    act(() => {
      onPointerMove!(
        {
          global: { x: 20, y: 10 },
        } as unknown as FederatedPointerEvent,
      );
    });

    expect(notifySpy).toHaveBeenCalledWith("position_1", "x", 60);

    const clipBeforeDrop = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clip.id);
    const transformBeforeDrop = clipBeforeDrop?.transformations.find(
      (transform) => transform.type === "position",
    );
    expect(transformBeforeDrop?.keyframeTimes).toEqual([0, 100]);

    const onPointerUp = getStageHandler("pointerup");
    expect(onPointerUp).toBeDefined();

    act(() => {
      onPointerUp!(
        {
          global: { x: 20, y: 10 },
        } as unknown as FederatedPointerEvent,
      );
    });

    const updatedClip = useTimelineStore
      .getState()
      .clips.find((currentClip) => currentClip.id === clip.id);
    expect(updatedClip).toBeDefined();

    const positionTransform = updatedClip?.transformations.find(
      (transform) => transform.type === "position",
    );
    expect(positionTransform).toBeDefined();
    expect(positionTransform?.keyframeTimes).toEqual([0, 50, 100]);

    const xParam = positionTransform?.parameters.x as {
      type: "spline";
      points: Array<{ time: number; value: number }>;
    };
    expect(xParam.type).toBe("spline");
    expect(xParam.points.map((point) => point.time)).toEqual([0, 50, 100]);
    expect(xParam.points.find((point) => point.time === 50)?.value).toBe(60);

    notifySpy.mockRestore();
  });
});
