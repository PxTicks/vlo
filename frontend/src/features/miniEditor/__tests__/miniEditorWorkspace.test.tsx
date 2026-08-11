import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorStageMount } from "../../../core/shell/components/EditorStageMount";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { editorSurfaceRegistry } from "../../../core/shell/editorSurfaces";
import { HostKeybindingRegistry } from "../../../core/shell/keybindingRegistry";
import { useShellLayoutStore } from "../../../core/shell/layout/useShellLayoutStore";
import { dedicatedWorkspaceController } from "../../../core/shell/workspaces";
import { hostViewRegistry } from "../../../core/shell/viewRegistry";
import { mediaSecondsToTick } from "../../../core/time";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { useEditorFocusStore } from "../../editorFocus";
import { installTimelineHostCommands } from "../../timeline/hostCommands";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { MiniEditorModal } from "../MiniEditorModal";
import {
  declareMiniEditorWorkspace,
  invalidateMiniEditorWorkspaceAsset,
  MINI_EDITOR_CONTROLS_SURFACE_ID,
  MINI_EDITOR_PREVIEW_SURFACE_ID,
  MINI_EDITOR_WORKSPACE_ID,
  openMiniEditorWorkspace,
} from "../miniEditorWorkspace";
import type { ResolvedEditorSource } from "../types";
import { useMiniEditorStore } from "../useMiniEditorStore";

function source(name = "asset.mp4"): ResolvedEditorSource {
  return {
    sourceUrl: `blob:${name}`,
    sourceFile: new File(["video"], name, { type: "video/mp4" }),
    durationTicks: mediaSecondsToTick(5),
    mediaType: "video",
  };
}

function timelineClip(id: string): TimelineClip {
  return {
    id,
    assetId: `asset-${id}`,
    trackId: "track-1",
    start: 0,
    type: "video",
    name: `${id}.mp4`,
    sourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    timelineDuration: 100,
    croppedSourceDuration: 100,
    offset: 0,
    transformations: [],
  };
}

function renderWorkspaceHost() {
  return render(
    <>
      <EditorStageMount stage="main-stage" />
      <EditorStageMount stage="lower-stage" />
      <MiniEditorModal />
    </>,
  );
}

describe("MiniEditor dedicated workspace canary", () => {
  const defaultSurfaceRegistrations: Array<{ dispose(): void }> = [];

  beforeAll(() => {
    if (!hostViewRegistry.get("host.assets")) {
      defaultSurfaceRegistrations.push(
        hostViewRegistry.registerHostView({
          id: "host.assets",
          title: "Assets",
          defaultRegion: "left-sidebar",
          component: () => <div data-testid="workspace-assets" />,
        }),
      );
    }
    defaultSurfaceRegistrations.push(
      editorSurfaceRegistry.register({
        id: "test.default-player",
        title: "Default player",
        defaultStage: "main-stage",
        order: -20,
        component: () => <div data-testid="default-player" />,
      }),
      editorSurfaceRegistry.register({
        id: "test.default-timeline",
        title: "Default timeline",
        defaultStage: "lower-stage",
        order: -20,
        component: () => <div data-testid="default-timeline" />,
      }),
    );
    declareMiniEditorWorkspace();
  });

  beforeEach(async () => {
    await dedicatedWorkspaceController.exit({ force: true });
    useMiniEditorStore.getState().close();
    useEditorFocusStore.getState().setRegion(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dedicatedWorkspaceController.exit({ force: true });
    for (const registration of defaultSurfaceRegistrations) {
      registration.dispose();
    }
  });

  it("replaces both editor stages and restores them on exit", async () => {
    const onClose = vi.fn();
    renderWorkspaceHost();

    await act(async () => {
      await openMiniEditorWorkspace({
        assetId: "asset-1",
        title: "Canary clip.mp4",
        args: {
          openerId: "test.asset-browser",
          title: "Canary clip.mp4",
          prepare: async () => source("canary.mp4"),
          onClose,
        },
      });
    });

    expect(dedicatedWorkspaceController.getSnapshot().active).toMatchObject({
      id: MINI_EDITOR_WORKSPACE_ID,
      subject: { assetId: "asset-1", title: "Canary clip.mp4" },
      subjectLabel: "Canary clip.mp4",
    });
    expect(useShellLayoutStore.getState().resolved.stages).toMatchObject({
      "main-stage": { surfaceId: MINI_EDITOR_PREVIEW_SURFACE_ID },
      "lower-stage": { surfaceId: MINI_EDITOR_CONTROLS_SURFACE_ID },
    });
    expect(
      useShellLayoutStore.getState().resolved.regions["left-sidebar"]
        .selectedViewId,
    ).toBe("host.assets");
    expect(useMiniEditorStore.getState().presentation).toBe("workspace");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Canary clip.mp4" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("mini-editor-controls")).toBeInTheDocument();

    await act(async () => {
      expect(await dedicatedWorkspaceController.exit()).toBe(true);
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(useMiniEditorStore.getState().isOpen).toBe(false);
    expect(useShellLayoutStore.getState().resolved.stages).toMatchObject({
      "main-stage": { surfaceId: "test.default-player" },
      "lower-stage": { surfaceId: "test.default-timeline" },
    });
  });

  it("uses the shared extraction guard before allowing workspace exit", async () => {
    renderWorkspaceHost();
    await act(async () => {
      await openMiniEditorWorkspace({
        assetId: "asset-2",
        title: "Extract me.mp4",
        args: {
          title: "Extract me.mp4",
          prepare: async () => source("extract.mp4"),
          onExtractRange: vi.fn(async () => undefined),
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Extract range" }));
    expect(useMiniEditorStore.getState().extractionMode).toBe("range");
    await act(async () => {
      expect(await dedicatedWorkspaceController.exit()).toBe(false);
    });
    expect(useMiniEditorStore.getState().extractionMode).toBeNull();
    expect(dedicatedWorkspaceController.getSnapshot().active?.id).toBe(
      MINI_EDITOR_WORKSPACE_ID,
    );

    await act(async () => {
      expect(await dedicatedWorkspaceController.exit()).toBe(true);
    });
  });

  it("closes the workspace after the shared save transaction succeeds", async () => {
    const onSave = vi.fn(async () => undefined);
    const onClose = vi.fn();
    renderWorkspaceHost();
    await act(async () => {
      await openMiniEditorWorkspace({
        assetId: "asset-save",
        title: "Save me.mp4",
        args: {
          title: "Save me.mp4",
          prepare: async () => source("save.mp4"),
          onSave,
          onClose,
        },
      });
    });

    await act(async () => {
      await useMiniEditorStore.getState().save();
    });
    await waitFor(() =>
      expect(dedicatedWorkspaceController.getSnapshot().active).toBeNull(),
    );
    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("default-player")).toBeInTheDocument();
    expect(screen.getByTestId("default-timeline")).toBeInTheDocument();
  });

  it("force-closes when the active asset subject is invalidated", async () => {
    const onClose = vi.fn();
    await openMiniEditorWorkspace({
      assetId: "asset-deleted",
      title: "Delete me.mp4",
      args: {
        title: "Delete me.mp4",
        prepare: async () => source("delete.mp4"),
        onClose,
      },
    });

    await expect(invalidateMiniEditorWorkspaceAsset("another-asset")).resolves.toBe(
      false,
    );
    await expect(
      invalidateMiniEditorWorkspaceAsset("asset-deleted"),
    ).resolves.toBe(true);
    expect(dedicatedWorkspaceController.getSnapshot().active).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("invalidates preparation without waiting for the feature promise", async () => {
    let resolveSource: ((value: ResolvedEditorSource) => void) | undefined;
    const onClose = vi.fn();
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const opening = openMiniEditorWorkspace({
      assetId: "asset-pending",
      title: "Pending.mp4",
      args: {
        title: "Pending.mp4",
        prepare: () =>
          new Promise((resolve) => {
            resolveSource = resolve;
          }),
        onClose,
      },
    });
    await waitFor(() => expect(resolveSource).toBeDefined());

    await act(async () => {
      expect(
        await invalidateMiniEditorWorkspaceAsset("asset-pending"),
      ).toBe(true);
    });
    await expect(opening).resolves.toEqual({ status: "cancelled" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(useMiniEditorStore.getState().isOpen).toBe(false);

    resolveSource?.(source("late.mp4"));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:late.mp4"));
  });

  it("owns a dedicated focus region so project timeline chords cannot dispatch", async () => {
    const contextKeys = new HostContextKeyService();
    const commands = new HostCommandTable(contextKeys);
    const keybindings = new HostKeybindingRegistry(() => false);
    const registration = installTimelineHostCommands(commands, keybindings);
    const clip = timelineClip("selected");
    useTimelineStore.setState({
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [clip],
      selectedClipIds: [clip.id],
      copiedClips: [],
    });
    contextKeys.set("project.open", true);
    contextKeys.set("selection.clipCount", 1);
    renderWorkspaceHost();
    await act(async () => {
      await openMiniEditorWorkspace({
        assetId: "asset-focus",
        title: "Focus.mp4",
        args: {
          title: "Focus.mp4",
          prepare: async () => source("focus.mp4"),
        },
      });
    });

    const controlsStage = screen
      .getByTestId("mini-editor-controls")
      .closest<HTMLElement>("[data-shell-stage]");
    expect(controlsStage).not.toBeNull();
    fireEvent.pointerDown(controlsStage as HTMLElement);
    expect(useEditorFocusStore.getState().region).toBe("miniEditor");

    for (const init of [
      { key: "Delete" },
      { key: "c", ctrlKey: true },
      { key: "v", ctrlKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...init,
        cancelable: true,
      });
      expect(
        keybindings.dispatch(
          event,
          useEditorFocusStore.getState().region,
          (commandId) =>
            commands.executeCommand(commandId, { source: "keybinding" }),
        ),
      ).toBe(false);
    }
    expect(useTimelineStore.getState().clips).toEqual([clip]);
    expect(useTimelineStore.getState().selectedClipIds).toEqual([clip.id]);
    expect(useTimelineStore.getState().copiedClips).toEqual([]);
    registration.dispose();
  });

  it("cancels a slow workspace activation when a modal takes ownership", async () => {
    let resolveWorkspaceSource:
      | ((value: ResolvedEditorSource) => void)
      | undefined;
    const workspaceClose = vi.fn();
    renderWorkspaceHost();
    const opening = openMiniEditorWorkspace({
      assetId: "asset-race",
      title: "Workspace.mp4",
      args: {
        openerId: "workspace-owner",
        title: "Workspace.mp4",
        prepare: () =>
          new Promise((resolve) => {
            resolveWorkspaceSource = resolve;
          }),
        onClose: workspaceClose,
      },
    });
    await waitFor(() => expect(resolveWorkspaceSource).toBeDefined());

    await act(async () => {
      await useMiniEditorStore.getState().open({
        openerId: "modal-owner",
        presentation: "modal",
        title: "Modal takeover",
        prepare: async () => source("modal.mp4"),
      });
    });

    await expect(opening).resolves.toEqual({ status: "cancelled" });
    expect(workspaceClose).toHaveBeenCalledOnce();
    expect(dedicatedWorkspaceController.getSnapshot().active).toBeNull();
    expect(screen.getByRole("dialog", { name: "Modal takeover" })).toBeVisible();
    expect(screen.getByTestId("default-player")).toBeInTheDocument();
    expect(screen.getByTestId("default-timeline")).toBeInTheDocument();

    resolveWorkspaceSource?.(source("late-workspace.mp4"));
  });

  it("truncates long asset names to the workspace subject-label limit", async () => {
    const longTitle = `${"Long asset ".repeat(20)}.mp4`;
    await expect(
      openMiniEditorWorkspace({
        assetId: "asset-long-title",
        title: longTitle,
        args: {
          title: longTitle,
          prepare: async () => source("long.mp4"),
        },
      }),
    ).resolves.toEqual({ status: "opened" });

    expect(
      dedicatedWorkspaceController.getSnapshot().active?.subjectLabel,
    ).toBe(longTitle.trim().slice(0, 160));
  });
});
