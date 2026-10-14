import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { useInteractionStore } from "../../../timeline/hooks/useInteractionStore";
import type { ResolvedTransition } from "../../../timeline/model/transitionModel";
import type { ExtensionApiScope, ExtensionResource } from "../../../extensions/types";
import type {
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../../types/TimelineTypes";
import { extensionTransitionRegistry } from "../../extensions/ExtensionTransitionRegistry";
import { TransitionPanel } from "../TransitionPanel";
import { TransitionLibraryPanel } from "../TransitionLibraryPanel";
import { TransitionOverlay } from "../TransitionOverlay";
import { TransitionCardSurface } from "../TransitionCard";

function track(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function clip(id: string, trackId: string, start: number): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: `${id}-asset`,
    start,
    timelineDuration: 96000,
    sourceDuration: 96000,
    transformedDuration: 96000,
    transformedOffset: 0,
    croppedSourceDuration: 96000,
    offset: 0,
    transformations: [],
  };
}

function scope(id: string): ExtensionApiScope {
  return {
    extension: { id, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function selectTransition(transition: Transition) {
  useTimelineStore.setState({
    tracks: [track("top"), track("bottom")],
    clips: [clip("in", "top", 48000), clip("out", "bottom", 0)],
    transitions: [transition],
    selectedTransitionId: transition.id,
    selectedClipIds: [],
  });
}

function currentParameters() {
  return useTimelineStore.getState().transitions[0]?.parameters;
}

describe("TransitionPanel", () => {
  let disposeExtension: (() => void) | null = null;

  beforeEach(() => {
    disposeExtension = extensionTransitionRegistry
      .bind(scope("example.panel"))
      .register({
        id: "everything",
        apiVersion: 1,
        label: "Everything",
        glyph: "E",
        schemaVersion: 1,
        groups: [
          {
            id: "all",
            title: "All controls",
            controls: [
              {
                type: "number",
                name: "count",
                label: "Count",
                defaultValue: 2,
                min: 0,
                max: 10,
              },
              { type: "checkbox", name: "flip", label: "Flip", defaultValue: false },
              { type: "text", name: "caption", label: "Caption", defaultValue: "hello" },
              { type: "color", name: "tint", label: "Tint", defaultValue: "#112233" },
            ],
          },
        ],
        renderFrame: () => ({}),
      }).dispose;
  });

  afterEach(() => {
    disposeExtension?.();
    useTimelineStore.setState({ transitions: [], selectedTransitionId: null });
  });

  it("asks for a selection when no transition is selected", () => {
    useTimelineStore.setState({ transitions: [], selectedTransitionId: null });
    render(<TransitionPanel />);
    expect(
      screen.getByText("Select a transition on the timeline."),
    ).toBeInTheDocument();
  });

  it("commits built-in slider and select edits to the selected transition", () => {
    selectTransition({
      id: "transition-zoom",
      type: "zoom",
      outgoingClipId: "out",
      incomingClipId: "in",
      parameters: { scale: 1.4, easing: "easeInOut" },
    });
    render(<TransitionPanel />);
    expect(screen.getByText("Zoom", { selector: "h6" })).toBeInTheDocument();

    // The readout field shares the slider's label; the range input is MUI's.
    const scale = screen
      .getAllByLabelText("Zoom")
      .find((element) => (element as HTMLInputElement).type !== "range")!;
    fireEvent.change(scale, { target: { value: "2" } });
    fireEvent.blur(scale);
    expect(currentParameters()).toMatchObject({ scale: 2 });

    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(
      within(screen.getByRole("listbox")).getByText("Linear"),
    );
    expect(currentParameters()).toMatchObject({ easing: "linear" });
  });

  it("renders extension controls and refuses values the extension rejects", () => {
    selectTransition({
      id: "transition-ext",
      type: "example.panel/everything",
      outgoingClipId: "out",
      incomingClipId: "in",
      schemaVersion: 1,
      parameters: { count: 2, flip: false, caption: "hello", tint: "#112233" },
    });
    render(<TransitionPanel />);
    expect(screen.getByText("Everything")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Flip" }));
    expect(currentParameters()).toMatchObject({ flip: true });

    const caption = screen.getByLabelText("Caption");
    fireEvent.change(caption, { target: { value: "bye" } });
    fireEvent.blur(caption);
    expect(currentParameters()).toMatchObject({ caption: "bye" });

    const tint = screen.getByLabelText("Tint");
    fireEvent.change(tint, { target: { value: "#ff0000" } });
    fireEvent.blur(tint);
    expect(currentParameters()).toMatchObject({ tint: "#ff0000" });

    const count = screen.getByLabelText("Count");
    fireEvent.change(count, { target: { value: "4" } });
    fireEvent.blur(count);
    expect(currentParameters()).toMatchObject({ count: 4 });
    fireEvent.change(count, { target: { value: "50" } });
    fireEvent.blur(count);
    // Out of the control's 0-10 range, so validation keeps the old value.
    expect(currentParameters()).toMatchObject({ count: 4 });
  });

  it("falls back to control defaults when stored values are missing", () => {
    selectTransition({
      id: "transition-ext",
      type: "example.panel/everything",
      outgoingClipId: "out",
      incomingClipId: "in",
      schemaVersion: 1,
      parameters: {},
    });
    render(<TransitionPanel />);
    expect(screen.getByLabelText("Caption")).toHaveValue("hello");
    expect(screen.getByLabelText("Count")).toHaveValue(2);
    expect(screen.getByRole("checkbox", { name: "Flip" })).not.toBeChecked();
  });
});

describe("TransitionLibraryPanel", () => {
  it("lists built-in and extension transitions as draggable cards", () => {
    const registration = extensionTransitionRegistry
      .bind(scope("example.library"))
      .register({
        id: "wipe",
        apiVersion: 1,
        label: "Library wipe",
        glyph: "W",
        schemaVersion: 1,
        renderFrame: () => ({}),
      });
    try {
      render(
        <DndContext>
          <TransitionLibraryPanel />
        </DndContext>,
      );
      expect(screen.getByText("Transitions")).toBeInTheDocument();
      expect(screen.getByText("Dissolve")).toBeInTheDocument();
      expect(screen.getByText("Library wipe")).toBeInTheDocument();

      act(() => registration.dispose());
      expect(screen.queryByText("Library wipe")).not.toBeInTheDocument();
    } finally {
      registration.dispose();
    }
  });
});

describe("TransitionOverlay", () => {
  it("spans both tracks and selects its transition on click", () => {
    const onSelect = vi.fn();
    const transition: Transition = {
      id: "transition-overlay",
      type: "spin",
      outgoingClipId: "out",
      incomingClipId: "in",
      parameters: {},
    };
    const resolved = {
      transition,
      outgoingClip: clip("out", "bottom", 0),
      incomingClip: clip("in", "top", 48000),
      start: 48000,
      end: 96000,
      duration: 48000,
      outgoingTrackIndex: 2,
      incomingTrackIndex: 1,
    } satisfies ResolvedTransition;

    const parentClick = vi.fn();
    const { rerender } = render(
      <div onClick={parentClick}>
        <TransitionOverlay resolved={resolved} selected={false} onSelect={onSelect} />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Spin transition" });
    expect(button).toHaveTextContent("↻");
    expect(button.style.boxShadow).toBe("");

    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("transition-overlay");
    expect(parentClick).not.toHaveBeenCalled();

    rerender(
      <div onClick={parentClick}>
        <TransitionOverlay resolved={resolved} selected onSelect={onSelect} />
      </div>,
    );
    expect(
      screen.getByTestId("transition-overlay-transition-overlay").style.boxShadow,
    ).not.toBe("");
  });
});

describe("TransitionCardSurface", () => {
  beforeEach(() => {
    useInteractionStore.setState({ transitionDropPreview: null });
  });

  it("renders the glyph and label in normal and rejected states", () => {
    const { rerender } = render(<TransitionCardSurface label="Dissolve" glyph="◐" />);
    expect(screen.getByText("Dissolve")).toBeInTheDocument();
    expect(screen.getByText("◐")).toBeInTheDocument();
    rerender(<TransitionCardSurface label="Dissolve" glyph="◐" rejected />);
    expect(screen.getByText("Dissolve")).toBeInTheDocument();
  });
});
