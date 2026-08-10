/**
 * The editor's own player and timeline, reached through their registered
 * surfaces (docs/configurable-docking-and-dedicated-workspaces-plan.md §7
 * Phase D acceptance).
 */
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorStageMount } from "../../../core/shell/components/EditorStageMount";
import { editorSurfaceRegistry } from "../../../core/shell/editorSurfaces";
import { describeEditorSurfaces } from "../../../core/shell/layout/layoutDescriptors";
import { useShellLayoutStore } from "../../../core/shell/layout/useShellLayoutStore";
import { useEditorFocusStore } from "../../../features/editorFocus";
import {
  EditorStageServicesContext,
  type EditorStageServices,
} from "../editorStageServices";
import { declareEditorStageSurfaces } from "../editorStageSurfaces";

const cancelTimelineInteractions = vi.fn();

vi.mock("../../../features/player/Player", () => ({
  Player: ({ chrome = "full" }: { readonly chrome?: string }) => (
    <div data-testid="player" data-chrome={chrome} />
  ),
}));

vi.mock("../../../features/timeline/ui", () => ({
  Timeline: ({
    scrollContainerRef,
    clipOverlays,
  }: {
    readonly scrollContainerRef: { current: HTMLDivElement | null };
    readonly clipOverlays: readonly { readonly id: string }[];
  }) => (
    <div
      data-testid="timeline"
      data-has-scroll-ref={scrollContainerRef !== undefined}
      data-overlays={clipOverlays.map((overlay) => overlay.id).join(",")}
    />
  ),
  cancelTimelineInteractions: () => cancelTimelineInteractions(),
}));

const services = {
  scrollContainerRef: createRef<HTMLDivElement>(),
  clipOverlays: [{ id: "mute-overlay", useItems: () => [] }],
} as unknown as EditorStageServices;

function renderStages() {
  return render(
    <EditorStageServicesContext.Provider value={services}>
      <EditorStageMount stage="main-stage" />
      <EditorStageMount stage="lower-stage" />
    </EditorStageServicesContext.Provider>,
  );
}

describe("editor stage surfaces", () => {
  beforeEach(() => {
    declareEditorStageSurfaces();
    useEditorFocusStore.getState().setRegion(null);
    cancelTimelineInteractions.mockClear();
  });

  afterEach(() => {
    act(() => {
      useShellLayoutStore.getState().clearStageSurfaces();
      // The surface table is application state; hand it back to the registry.
      useShellLayoutStore
        .getState()
        .setSurfaceDescriptors(describeEditorSurfaces());
    });
  });

  it("registers the player and timeline as host surfaces", () => {
    expect(editorSurfaceRegistry.get("host.player")).toMatchObject({
      title: "Player",
      defaultStage: "main-stage",
      allowedStages: ["main-stage"],
      focusRegion: "canvas",
    });
    expect(editorSurfaceRegistry.get("host.timeline")).toMatchObject({
      title: "Timeline",
      defaultStage: "lower-stage",
      allowedStages: ["lower-stage"],
      focusRegion: "timeline",
      cancelInteractions: expect.any(Function),
    });

    // Declaring twice is what module-scope registration does under HMR and in
    // tests; it must not throw or duplicate.
    expect(() => declareEditorStageSurfaces()).not.toThrow();
  });

  it("mounts the default editor: full player above the timeline", () => {
    renderStages();

    expect(screen.getByTestId("player")).toHaveAttribute("data-chrome", "full");
    expect(screen.getByTestId("timeline")).toHaveAttribute(
      "data-overlays",
      "mute-overlay",
    );
    expect(screen.getByTestId("timeline")).toHaveAttribute(
      "data-has-scroll-ref",
      "true",
    );

    fireEvent.pointerDown(screen.getByTestId("timeline"));
    expect(useEditorFocusStore.getState().region).toBe("timeline");
    fireEvent.pointerDown(screen.getByTestId("player"));
    expect(useEditorFocusStore.getState().region).toBe("canvas");
  });

  it("swaps the picture for the compact preview without a second player", () => {
    renderStages();

    act(() => {
      expect(
        useShellLayoutStore
          .getState()
          .setStageSurface("main-stage", "host.compact-preview"),
      ).toBe(true);
    });

    const previews = screen.getAllByTestId("player");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toHaveAttribute("data-chrome", "compact");
  });

  it("cancels timeline editing before the lower stage is replaced", () => {
    renderStages();

    act(() => {
      useShellLayoutStore
        .getState()
        .setStageSurface("lower-stage", "host.timeline");
      // Composing the lower stage with a surface it does not permit is refused
      // outright, so the only way out of the timeline is a compatible surface.
      expect(
        useShellLayoutStore
          .getState()
          .setStageSurface("lower-stage", "host.player"),
      ).toBe(false);
    });
    expect(cancelTimelineInteractions).not.toHaveBeenCalled();

    act(() => {
      useShellLayoutStore.getState().setSurfaceDescriptors([]);
    });

    expect(screen.queryByTestId("timeline")).not.toBeInTheDocument();
    expect(cancelTimelineInteractions).toHaveBeenCalled();
  });
});
