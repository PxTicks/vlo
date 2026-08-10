/**
 * The stage mount's focus, lifecycle, and cancellation rules
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §7 Phase D, §8.2).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Component, useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachEditorRegionFocusAuthority,
  type EditorRegion,
  type EditorRegionClaimant,
} from "../../editorRegions";
import { editorSurfaceRegistry } from "../../editorSurfaces";
import { useShellLayoutStore } from "../../layout/useShellLayoutStore";
import { EditorStageMount } from "../EditorStageMount";

const disposers: Array<() => void> = [];
/** Mirrors the focus store: a region plus whoever claimed it. */
let focus: {
  region: EditorRegion | null;
  claimant: EditorRegionClaimant | null;
} = { region: null, claimant: null };
const cancelTimeline = vi.fn();
let timelineMounts = 0;

function TimelineSurface() {
  const [note, setNote] = useState("");
  useEffect(() => {
    timelineMounts += 1;
  }, []);
  return (
    <div data-testid="timeline-surface">
      <input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
    </div>
  );
}

/** Stands in for the app's error boundary, which core must not import. */
class Boundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? (
      <div data-testid="boundary-fallback" />
    ) : (
      this.props.children
    );
  }
}

function registerSurfaces() {
  disposers.push(
    editorSurfaceRegistry.register({
      id: "test.timeline",
      title: "Timeline",
      defaultStage: "lower-stage",
      focusRegion: "timeline",
      cancelInteractions: cancelTimeline,
      component: TimelineSurface,
    }).dispose,
    editorSurfaceRegistry.register({
      id: "test.grading",
      title: "Grading",
      defaultStage: "main-stage",
      allowedStages: ["main-stage", "lower-stage"],
      focusRegion: "inspector",
      component: () => <div data-testid="grading-surface" />,
    }).dispose,
    // Owns the same region as the grading surface, from the other stage.
    editorSurfaceRegistry.register({
      id: "test.notes",
      title: "Notes",
      defaultStage: "lower-stage",
      order: 10,
      focusRegion: "inspector",
      component: () => <div data-testid="notes-surface" />,
    }).dispose,
  );
}

describe("EditorStageMount", () => {
  beforeEach(() => {
    timelineMounts = 0;
    cancelTimeline.mockClear();
    focus = { region: null, claimant: null };
    attachEditorRegionFocusAuthority({
      claim: (region, claimant) => {
        focus = { region, claimant };
      },
      release: (claimant) => {
        if (focus.claimant === claimant) focus = { region: null, claimant: null };
      },
    });
    registerSurfaces();
  });

  afterEach(() => {
    act(() => {
      useShellLayoutStore.getState().clearStageSurfaces();
    });
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("mounts the stage's resolved surface and claims its focus region", () => {
    render(<EditorStageMount stage="lower-stage" />);

    const surface = screen.getByTestId("timeline-surface");
    expect(surface).toBeInTheDocument();
    const stage = surface.closest("[data-shell-stage='lower-stage']");
    expect(stage).toHaveAttribute("data-editor-region", "timeline");

    fireEvent.pointerDown(surface);
    // The claim is the stage element's, not the region name's.
    expect(focus).toEqual({ region: "timeline", claimant: stage });
  });

  it("cancels and releases the outgoing surface when a stage is replaced", () => {
    render(<EditorStageMount stage="lower-stage" />);
    fireEvent.pointerDown(screen.getByTestId("timeline-surface"));
    expect(focus.region).toBe("timeline");

    act(() => {
      useShellLayoutStore.getState().setStageSurface("lower-stage", "test.grading");
    });

    // Nothing the timeline was dragging outlives the timeline, and the
    // keyboard ownership it held goes with it — otherwise a region-scoped
    // shortcut would fire at a surface that is no longer on screen.
    expect(cancelTimeline).toHaveBeenCalled();
    expect(focus.region).toBeNull();
    expect(screen.queryByTestId("timeline-surface")).not.toBeInTheDocument();
    expect(screen.getByTestId("grading-surface")).toBeInTheDocument();
  });

  it("leaves ownership alone when another area holds the same region", () => {
    // Several areas legitimately own one region name — in the editor the player
    // frame, the main stage, the aside, and the dock all own "canvas" — so a
    // removed stage may only drop the claim it actually made.
    render(
      <>
        <EditorStageMount stage="main-stage" />
        <EditorStageMount stage="lower-stage" />
      </>,
    );
    act(() => {
      useShellLayoutStore.getState().setStageSurface("lower-stage", "test.notes");
    });
    const lowerStage = document.querySelector(
      "[data-shell-stage='lower-stage']",
    );

    fireEvent.pointerDown(screen.getByTestId("grading-surface"));
    fireEvent.pointerDown(screen.getByTestId("notes-surface"));
    expect(focus).toEqual({ region: "inspector", claimant: lowerStage });

    act(() => {
      useShellLayoutStore
        .getState()
        .setSurfaceDescriptors(
          useShellLayoutStore
            .getState()
            .surfaces.filter((descriptor) => descriptor.id !== "test.grading"),
        );
    });

    expect(screen.queryByTestId("grading-surface")).not.toBeInTheDocument();
    expect(focus).toEqual({ region: "inspector", claimant: lowerStage });
  });

  it("mounts one surface per stage, with no replaced surface left behind", () => {
    render(
      <>
        <EditorStageMount stage="main-stage" />
        <EditorStageMount stage="lower-stage" />
      </>,
    );

    expect(screen.getAllByTestId("grading-surface")).toHaveLength(1);
    expect(timelineMounts).toBe(1);

    act(() => {
      useShellLayoutStore.getState().setStageSurface("lower-stage", "test.grading");
    });

    expect(screen.getAllByTestId("grading-surface")).toHaveLength(2);
    expect(screen.queryByTestId("timeline-surface")).not.toBeInTheDocument();
  });

  it("cancels when the mounted surface is unregistered out from under it", () => {
    render(<EditorStageMount stage="lower-stage" />);

    act(() => {
      disposers.shift()?.();
    });

    expect(cancelTimeline).toHaveBeenCalled();
    expect(screen.queryByTestId("timeline-surface")).not.toBeInTheDocument();
  });

  it("survives a canceller that throws while its surface is unregistered", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const dispose = editorSurfaceRegistry.register({
      id: "test.hostile",
      title: "Hostile",
      defaultStage: "main-stage",
      order: -1,
      focusRegion: "canvas",
      cancelInteractions: () => {
        throw new Error("cancel failed");
      },
      component: () => <div data-testid="hostile-surface" />,
    }).dispose;
    disposers.push(dispose);
    render(<EditorStageMount stage="main-stage" />);
    fireEvent.pointerDown(screen.getByTestId("hostile-surface"));

    // The throw would otherwise escape React's cleanup, where no error boundary
    // can catch it, and take the whole editor down instead of one surface.
    act(() => {
      dispose();
    });

    expect(screen.queryByTestId("hostile-surface")).not.toBeInTheDocument();
    expect(screen.getByTestId("grading-surface")).toBeInTheDocument();
    // The failure is reported, and ownership is still released.
    expect(consoleError).toHaveBeenCalled();
    expect(focus.region).toBeNull();
    consoleError.mockRestore();
  });

  it("renders an empty stage rather than failing when nothing is registered", () => {
    for (const dispose of disposers.splice(0)) dispose();

    render(<EditorStageMount stage="lower-stage" />);

    const stage = document.querySelector("[data-shell-stage='lower-stage']");
    expect(stage).toBeEmptyDOMElement();
    expect(stage).not.toHaveAttribute("data-editor-region");
  });

  it("wraps the surface so the app can contain its failures", () => {
    render(
      <EditorStageMount
        stage="lower-stage"
        wrap={(surface, content) => (
          <div data-testid="boundary" data-boundary={surface.title}>
            {content}
          </div>
        )}
      />,
    );

    expect(screen.getByTestId("boundary")).toHaveAttribute(
      "data-boundary",
      "Timeline",
    );
    expect(screen.getByTestId("timeline-surface")).toBeInTheDocument();
  });

  it("gives a replacement a clean wrapper after the previous surface crashed", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    disposers.push(
      editorSurfaceRegistry.register({
        id: "test.broken",
        title: "Broken",
        defaultStage: "lower-stage",
        order: -1,
        component: () => {
          throw new Error("surface failed");
        },
      }).dispose,
    );

    render(
      <EditorStageMount
        stage="lower-stage"
        wrap={(_surface, content) => <Boundary>{content}</Boundary>}
      />,
    );
    expect(screen.getByTestId("boundary-fallback")).toBeInTheDocument();

    // A crashed surface must not leave the stage permanently broken: the exit
    // is to mount something else, and the caught state must not come along.
    act(() => {
      useShellLayoutStore.getState().setStageSurface("lower-stage", "test.grading");
    });

    expect(screen.queryByTestId("boundary-fallback")).not.toBeInTheDocument();
    expect(screen.getByTestId("grading-surface")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
