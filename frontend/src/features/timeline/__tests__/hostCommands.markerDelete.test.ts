import { beforeEach, describe, expect, it } from "vitest";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../core/shell/keybindingRegistry";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { installTimelineHostCommands } from "../hostCommands";
import { useTimelineStore } from "../useTimelineStore";

function clipWithMarkers(markerIds: readonly string[]): TimelineClip {
  return {
    id: "clip_1",
    trackId: "track_1",
    start: 0,
    type: "video",
    assetId: "asset_1",
    name: "Clip 1",
    sourceDuration: 300,
    transformedDuration: 300,
    transformedOffset: 0,
    timelineDuration: 300,
    croppedSourceDuration: 300,
    offset: 0,
    transformations: [],
    components: [
      {
        id: "markers_1",
        type: "markers",
        parameters: {
          markers: markerIds.map((id, index) => ({
            id,
            sourceTimeTicks: index * 100,
          })),
        },
      },
    ],
  };
}

function createHarness() {
  const contextKeys = new HostContextKeyService();
  contextKeys.set("project.open", true);
  const table = new HostCommandTable(contextKeys);
  const keybindings = new HostKeybindingRegistry(() => false);
  const registration = installTimelineHostCommands(table, keybindings);
  return { table, registration };
}

function getMarkers(): readonly { id: string }[] {
  const clip = useTimelineStore.getState().clips[0];
  if (clip.type === "mask") throw new Error("unexpected mask clip");
  const component = (clip.components ?? []).find(
    (candidate) => candidate.type === "markers",
  );
  return component?.type === "markers" ? component.parameters.markers : [];
}

describe("timeline.marker.delete", () => {
  beforeEach(() => {
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
      selectedClipIds: [],
    });
  });

  it("removes one marker and keeps the component while markers remain", () => {
    useTimelineStore.setState({ clips: [clipWithMarkers(["m1", "m2"])] });
    const { table, registration } = createHarness();
    try {
      expect(
        table.executeCommand("timeline.marker.delete", {
          subject: { clipId: "clip_1", markerId: "m1" },
          source: "menu",
        }),
      ).toBe(true);
      expect(getMarkers().map((marker) => marker.id)).toEqual(["m2"]);
    } finally {
      registration.dispose();
    }
  });

  it("removes the markers component with the last marker", () => {
    useTimelineStore.setState({ clips: [clipWithMarkers(["m1"])] });
    const { table, registration } = createHarness();
    try {
      table.executeCommand("timeline.marker.delete", {
        subject: { clipId: "clip_1", markerId: "m1" },
        source: "menu",
      });
      const clip = useTimelineStore.getState().clips[0];
      if (clip.type === "mask") throw new Error("unexpected mask clip");
      expect(
        (clip.components ?? []).some((component) => component.type === "markers"),
      ).toBe(false);
    } finally {
      registration.dispose();
    }
  });

  it("is a no-op for unknown markers or clips", () => {
    useTimelineStore.setState({ clips: [clipWithMarkers(["m1"])] });
    const { table, registration } = createHarness();
    try {
      table.executeCommand("timeline.marker.delete", {
        subject: { clipId: "clip_1", markerId: "missing" },
        source: "menu",
      });
      table.executeCommand("timeline.marker.delete", {
        subject: { clipId: "missing", markerId: "m1" },
        source: "menu",
      });
      expect(getMarkers().map((marker) => marker.id)).toEqual(["m1"]);
    } finally {
      registration.dispose();
    }
  });
});
