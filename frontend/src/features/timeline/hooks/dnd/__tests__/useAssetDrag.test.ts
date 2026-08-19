import { act, renderHook } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInteractionStore } from "../../useInteractionStore";
import { useAssetDrag } from "../useAssetDrag";

const { mockHandleEnd, mockHandleMove } = vi.hoisted(() => ({
  mockHandleEnd: vi.fn(),
  mockHandleMove: vi.fn(),
}));

vi.mock("../useClipMove", () => ({
  useClipMove: () => ({
    handleEnd: mockHandleEnd,
    handleMove: mockHandleMove,
  }),
}));

describe("useAssetDrag", () => {
  beforeEach(() => {
    mockHandleEnd.mockReset();
    mockHandleMove.mockReset();
    useInteractionStore.getState().stopDrag();
  });

  it("routes managed media-input drops to the target slot callback", () => {
    const onReorderDrop = vi.fn();
    const { result } = renderHook(() => useAssetDrag());

    act(() => {
      result.current.handleAssetDragEnd({
        active: {
          data: {
            current: {
              type: "media-input",
              inputId: "62:image",
            },
          },
        },
        over: {
          data: {
            current: {
              type: "asset-slot",
              onReorderDrop,
            },
          },
        },
      } as unknown as DragEndEvent);
    });

    expect(onReorderDrop).toHaveBeenCalledWith({
      type: "media-input",
      inputId: "62:image",
    });
    expect(mockHandleEnd).not.toHaveBeenCalled();
  });
  it("lets a slot admit an asset its accept list rejects, via acceptAsset", () => {
    const onDrop = vi.fn();
    const videoAsset = {
      id: "asset-video",
      hash: "hash",
      name: "clip.mp4",
      type: "video",
      src: "assets/clip.mp4",
      hasAudio: true,
      createdAt: 0,
    };
    const { result } = renderHook(() => useAssetDrag());

    act(() => {
      result.current.handleAssetDragEnd({
        active: { data: { current: { type: "asset", asset: videoAsset } } },
        over: {
          data: {
            current: {
              type: "asset-slot",
              accept: ["audio"],
              acceptAsset: (candidate: { type: string }) =>
                candidate.type === "video",
              onDrop,
            },
          },
        },
      } as unknown as DragEndEvent);
    });

    expect(onDrop).toHaveBeenCalledWith(videoAsset, null);
  });

  it("still rejects an asset that neither accept nor acceptAsset admits", () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => useAssetDrag());

    act(() => {
      result.current.handleAssetDragEnd({
        active: {
          data: {
            current: {
              type: "asset",
              asset: {
                id: "asset-image",
                hash: "hash",
                name: "frame.png",
                type: "image",
                src: "assets/frame.png",
                createdAt: 0,
              },
            },
          },
        },
        over: {
          data: {
            current: {
              type: "asset-slot",
              accept: ["audio"],
              acceptAsset: (candidate: { type: string }) =>
                candidate.type === "video",
              onDrop,
            },
          },
        },
      } as unknown as DragEndEvent);
    });

    expect(onDrop).not.toHaveBeenCalled();
  });
});
