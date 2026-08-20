import { describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { ProjectData } from "../../services/ExportRenderer";
import { buildSelectionProjectData } from "../buildSelectionProjectData";

describe("buildSelectionProjectData", () => {
  it("uses only snapshot topology while retaining project resources", () => {
    const projectTrack = { id: "live-track" } as TimelineTrack;
    const projectClip = {
      id: "live-clip",
      trackId: projectTrack.id,
      start: 0,
      timelineDuration: 96_000,
      type: "video",
    } as TimelineClip;
    const snapshotTrack = { id: "saved-track", type: "visual" } as TimelineTrack;
    const snapshotClip = {
      id: "saved-clip",
      trackId: snapshotTrack.id,
      assetId: "saved-asset",
      start: 84_000,
      timelineDuration: 292_032,
      type: "video",
    } as TimelineClip;
    const asset = {
      id: "saved-asset",
      hash: "hash",
      name: "saved.mp4",
      src: "saved.mp4",
      type: "video",
      createdAt: 1,
    } satisfies Asset;
    const projectData: ProjectData = {
      tracks: [projectTrack],
      clips: [projectClip],
      transitions: [
        {
          id: "live-transition",
          type: "dissolve",
          outgoingClipId: "live-clip",
          incomingClipId: "other-live-clip",
          parameters: {},
        },
      ],
      assets: [asset],
      composites: [],
      duration: 96_000,
      fps: 24,
    };
    const selection: TimelineSelection = {
      start: 84_000,
      clips: [snapshotClip],
      tracks: [snapshotTrack],
      fps: 24,
    };

    const result = buildSelectionProjectData(projectData, selection);

    expect(result).toMatchObject({
      tracks: [snapshotTrack],
      clips: [snapshotClip],
      transitions: [],
      assets: [asset],
      composites: [],
      duration: 376_032,
      fps: 24,
    });
    expect(result.tracks).not.toContain(projectTrack);
    expect(result.clips).not.toContain(projectClip);
  });

  it("derives missing track records from snapshot clips, not live tracks", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectData = {
      tracks: [
        {
          id: "live-track",
          type: "visual",
          label: "Live",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
      clips: [],
      assets: [],
      duration: 0,
      fps: 24,
    } satisfies ProjectData;
    const selection = {
      start: 0,
      clips: [
        {
          id: "saved-audio",
          trackId: "detached-track",
          start: 0,
          timelineDuration: 96_000,
          type: "audio",
        } as TimelineClip,
      ],
    } satisfies TimelineSelection;

    try {
      expect(buildSelectionProjectData(projectData, selection).tracks).toEqual([
        {
          id: "detached-track",
          type: "audio",
          label: "Saved selection",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("omitted tracks"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
