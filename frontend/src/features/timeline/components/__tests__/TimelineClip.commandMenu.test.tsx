import { fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { TimelineClipItem } from "../TimelineClip";
import { useTimelineStore } from "../../useTimelineStore";
import { useInteractionStore } from "../../hooks/useInteractionStore";
import { installTimelineHostCommands } from "../../hostCommands";
import { hostContextKeys } from "../../../../core/shell/contextKeys";
import { installTimelineContextKeys } from "../../../extensions/commands/installHostContextKeys";
import type {
  StandardTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { PIXELS_PER_SECOND, TICKS_PER_SECOND } from "../../constants";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
    transform: null,
  }),
}));

vi.mock("../ThumbnailCanvas", () => ({
  ThumbnailCanvas: () => <div data-testid="thumbnail-canvas" />,
}));

vi.mock("../../hooks/useTimelineViewStore", () => {
  const state = {
    zoomScale: 1,
    ticksToPx: (ticks: number) =>
      (ticks / TICKS_PER_SECOND) * PIXELS_PER_SECOND,
    pxToTicks: (pixels: number) =>
      Math.round((pixels / PIXELS_PER_SECOND) * TICKS_PER_SECOND),
    setZoomScale: vi.fn(),
    setScrollContainer: vi.fn(),
    scrollContainer: null,
  };
  return {
    useTimelineViewStore: Object.assign(
      (selector: (value: unknown) => unknown) => selector(state),
      { getState: () => state, subscribe: vi.fn(() => vi.fn()) },
    ),
  };
});

vi.mock("../../../userAssets/api", () => ({
  useAsset: () => ({ id: "asset-1", hasAudio: true }),
}));

vi.mock("../../../samAudio", () => ({
  useSamAudioExtractDialogStore: Object.assign(() => vi.fn(), {
    getState: () => ({ openForClip: vi.fn() }),
  }),
}));

const baseClip: StandardTimelineClip = {
  id: "clip_1",
  trackId: "track_1",
  start: 0,
  timelineDuration: TICKS_PER_SECOND,
  type: "audio",
  name: "Test Audio",
  assetId: "asset-1",
  transformations: [],
  offset: 0,
  sourceDuration: TICKS_PER_SECOND,
  transformedDuration: TICKS_PER_SECOND,
  transformedOffset: 0,
  croppedSourceDuration: TICKS_PER_SECOND,
};

const track: TimelineTrack = {
  id: "track_1",
  type: "audio",
  label: "Audio",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

// The clip menu's delete/copy/mute items dispatch through the host command
// table, gated on the project.open context key — the same wiring production
// installs at runtime bootstrap.
describe("TimelineClip command-backed context menu items", () => {
  let commands: { dispose: () => void | Promise<void> };
  let timelineKeys: { dispose: () => void | Promise<void> };

  beforeAll(() => {
    commands = installTimelineHostCommands();
    // Live selection keys drive Copy's enablement as the right-click selects.
    timelineKeys = installTimelineContextKeys();
    hostContextKeys.set("project.open", true);
  });

  afterAll(() => {
    void commands.dispose();
    void timelineKeys.dispose();
    hostContextKeys.set("project.open", undefined);
  });

  beforeEach(() => {
    useTimelineStore.setState({
      clips: [baseClip],
      tracks: [track],
      selectedClipIds: [],
    });
    useInteractionStore.setState({ activeId: null, operation: null });
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }
  });

  it("Delete removes the right-clicked clip through timeline.clip.delete", () => {
    render(<TimelineClipItem clip={baseClip} isOverlay={false} />);
    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));

    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(deleteItem);

    expect(useTimelineStore.getState().clips).toEqual([]);
    expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("Copy stores the selection so paste duplicates it", () => {
    render(<TimelineClipItem clip={baseClip} isOverlay={false} />);
    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));

    expect(useTimelineStore.getState().pasteCopiedClipAbove()).toBe(true);
    expect(useTimelineStore.getState().clips).toHaveLength(2);
  });

  it("Mute toggles the clip through timeline.clip.toggle-mute", () => {
    render(<TimelineClipItem clip={baseClip} isOverlay={false} />);
    fireEvent.contextMenu(screen.getByTestId("timeline-clip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }));

    const updated = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.id === baseClip.id);
    expect(updated).toMatchObject({ isMuted: true });
  });

  it("renders command items disabled when no project is open", () => {
    hostContextKeys.set("project.open", false);
    try {
      render(<TimelineClipItem clip={baseClip} isOverlay={false} />);
      fireEvent.contextMenu(screen.getByTestId("timeline-clip"));
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    } finally {
      hostContextKeys.set("project.open", true);
    }
  });
});
