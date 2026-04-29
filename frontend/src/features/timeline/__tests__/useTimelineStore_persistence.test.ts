import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimelineStore } from "../useTimelineStore";
import { projectDocumentService } from "../../project/services/ProjectDocumentService";
import { fileSystemService } from "../../project/services/FileSystemService";
import type { Patch } from "../../../lib/immerLite";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";

const createTrack = (id: string, label: string): TimelineTrack => ({
  id,
  label,
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

const createClip = (id: string, trackId: string): TimelineClip =>
  ({
    id,
    trackId,
    type: "video",
    name: id,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    croppedSourceDuration: 100,
    transformedOffset: 0,
    sourceDuration: 100,
    transformedDuration: 100,
    transformations: [],
  }) as TimelineClip;

describe("useTimelineStore persistence", () => {
  let applyPatchesSpy: ReturnType<typeof vi.spyOn>;
  let getHandleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    projectDocumentService.resetProjectDocumentCache();

    getHandleSpy = vi
      .spyOn(fileSystemService, "getHandle")
      .mockReturnValue({} as FileSystemDirectoryHandle);

    applyPatchesSpy = vi
      .spyOn(projectDocumentService, "applyProjectDocumentPatches")
      .mockResolvedValue({});

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track-1", "Track 1")],
      clips: [],
    });
  });

  afterEach(() => {
    applyPatchesSpy.mockRestore();
    getHandleSpy.mockRestore();
    vi.useRealTimers();
  });

  it("debounces burst mutations into one persistence write", async () => {
    act(() => {
      useTimelineStore.getState().addClip(createClip("clip-a", "track-1"));
      useTimelineStore.getState().addClip(createClip("clip-b", "track-1"));
      useTimelineStore.getState().updateClipPosition("clip-a", 80);
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(applyPatchesSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(applyPatchesSpy).toHaveBeenCalledTimes(1);

    const [patches] = applyPatchesSpy.mock.calls[0] as [Patch[]];
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((patch) => patch.path[0] === "timeline")).toBe(true);
  });

  it("persists undo and redo mutations", async () => {
    act(() => {
      useTimelineStore.getState().addClip(createClip("clip-c", "track-1"));
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(applyPatchesSpy).toHaveBeenCalledTimes(1);

    act(() => {
      expect(useTimelineStore.getState().undo()).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(applyPatchesSpy).toHaveBeenCalledTimes(2);

    act(() => {
      expect(useTimelineStore.getState().redo()).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(applyPatchesSpy).toHaveBeenCalledTimes(3);
  });
});

