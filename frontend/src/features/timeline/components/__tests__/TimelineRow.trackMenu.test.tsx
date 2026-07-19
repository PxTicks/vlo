import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextMenuService } from "../../../../core/shell/contextMenuService";
import { HostCommandTable } from "../../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../../core/shell/keybindingRegistry";
import type { TimelineTrack } from "../../../../types/TimelineTypes";
import { installTimelineHostCommands } from "../../hostCommands";
import { useTimelineStore } from "../../useTimelineStore";
import { TimelineRow } from "../TimelineRow";

vi.mock("../TimelineBody", () => ({
  TimelineBody: () => null,
}));

const TRACK: TimelineTrack = {
  id: "track_1",
  label: "Track 1",
  isVisible: true,
  isLocked: false,
  isMuted: false,
  type: "visual",
};

afterEach(() => {
  act(() => contextMenuService.close());
});

describe("timeline track header menu", () => {
  it("opens the catalogued track menu with toggle command items", () => {
    render(
      <TimelineRow
        track={TRACK}
        index={0}
        onToggleVisibility={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId("timeline-track-header"), {
      clientX: 40,
      clientY: 80,
    });

    const active = contextMenuService.getActive();
    expect(active).toMatchObject({
      menuId: "timeline.track.context",
      position: { x: 40, y: 80 },
      subject: {
        slot: "timeline.track.context",
        track: {
          id: "track_1",
          label: "Track 1",
          type: "visual",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      },
    });
    expect(active?.items).toMatchObject([
      {
        kind: "command",
        command: "timeline.track.toggle-visibility",
        subject: { trackId: "track_1" },
        label: "Hide track",
      },
      {
        kind: "command",
        command: "timeline.track.toggle-mute",
        subject: { trackId: "track_1" },
        label: "Mute track",
      },
    ]);
  });

  it("dispatches the track toggle commands against the store", () => {
    useTimelineStore.setState({ tracks: [{ ...TRACK }], clips: [] });
    const contextKeys = new HostContextKeyService();
    contextKeys.set("project.open", true);
    const table = new HostCommandTable(contextKeys);
    const registration = installTimelineHostCommands(
      table,
      new HostKeybindingRegistry(() => false),
    );
    try {
      table.executeCommand("timeline.track.toggle-visibility", {
        subject: { trackId: "track_1" },
        source: "menu",
      });
      expect(useTimelineStore.getState().tracks[0].isVisible).toBe(false);

      table.executeCommand("timeline.track.toggle-mute", {
        subject: { trackId: "track_1" },
        source: "menu",
      });
      expect(useTimelineStore.getState().tracks[0].isMuted).toBe(true);
    } finally {
      registration.dispose();
    }
  });
});
