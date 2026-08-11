import { editorSurfaceRegistry } from "../../core/shell/editorSurfaces";
import {
  dedicatedWorkspaceController,
  dedicatedWorkspaceRegistry,
  type DedicatedWorkspaceSession,
  type WorkspaceActivationResult,
} from "../../core/shell/workspaces";
import {
  MiniEditorWorkspaceControlsSurface,
  MiniEditorWorkspacePreviewSurface,
} from "./MiniEditorWorkspaceSurfaces";
import type { MiniEditorOpenArgs } from "./types";
import { useMiniEditorStore } from "./useMiniEditorStore";

export const MINI_EDITOR_WORKSPACE_ID = "host.mini-editor";
export const MINI_EDITOR_PREVIEW_SURFACE_ID = "host.mini-editor-preview";
export const MINI_EDITOR_CONTROLS_SURFACE_ID = "host.mini-editor-controls";

interface MiniEditorWorkspaceSubject {
  readonly assetId: string;
  readonly launchId: string;
  readonly title: string;
}

interface PendingLaunch {
  readonly args: MiniEditorOpenArgs;
}

const pendingLaunches = new Map<string, PendingLaunch>();
let installed = false;

function isWorkspaceSubject(value: unknown): value is MiniEditorWorkspaceSubject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const subject = value as Partial<MiniEditorWorkspaceSubject>;
  return (
    typeof subject.assetId === "string" &&
    subject.assetId.length > 0 &&
    subject.assetId.length <= 256 &&
    typeof subject.launchId === "string" &&
    subject.launchId.length > 0 &&
    subject.launchId.length <= 128 &&
    typeof subject.title === "string" &&
    subject.title.trim().length > 0 &&
    subject.title.length <= 160
  );
}

function waitForOpenOrAbort(
  opening: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void opening.then(finish, finish);
  });
}

async function createWorkspaceSession(
  subject: MiniEditorWorkspaceSubject,
  signal: AbortSignal,
  requestClose: () => Promise<boolean>,
): Promise<DedicatedWorkspaceSession> {
  const launch = pendingLaunches.get(subject.launchId);
  if (!launch) {
    throw new Error(
      `MiniEditor launch '${subject.launchId}' is no longer available.`,
    );
  }
  pendingLaunches.delete(subject.launchId);
  const args: MiniEditorOpenArgs = {
    ...launch.args,
    presentation: "workspace",
  };
  const owner = args.prepare;
  const opening = useMiniEditorStore.getState().open(args);
  let sessionReady = false;
  let resolveOwnershipLost: (() => void) | undefined;
  const ownershipLost = new Promise<"ownership-lost">((resolve) => {
    resolveOwnershipLost = () => resolve("ownership-lost");
  });
  const unsubscribe = useMiniEditorStore.subscribe((state, previous) => {
    if (
      state.isOpen &&
      state.presentation === "workspace" &&
      state._internal.prepare === owner
    ) return;
    if (!previous.isOpen || previous._internal.prepare !== owner) return;
    if (!sessionReady) {
      resolveOwnershipLost?.();
      return;
    }
    // A workspace-to-workspace switch is serialized by the controller; only
    // an external presentation takeover owns closing the active session.
    if (!state.isOpen || state.presentation === "modal") void requestClose();
  });
  const current = useMiniEditorStore.getState();
  if (
    !current.isOpen ||
    current.presentation !== "workspace" ||
    current._internal.prepare !== owner
  ) {
    resolveOwnershipLost?.();
  }
  const outcome = await Promise.race([
    waitForOpenOrAbort(opening, signal).then(() => "settled" as const),
    ownershipLost,
  ]);
  if (outcome === "ownership-lost") {
    unsubscribe();
    await requestClose();
    return { dispose: () => undefined };
  }
  sessionReady = true;

  return {
    requestClose: async () => {
      const state = useMiniEditorStore.getState();
      if (!state.isOpen || state._internal.prepare !== owner) return "close";
      if (
        state.status === "saving" ||
        state.status === "extracting-range" ||
        state.status === "extracting-frame"
      ) {
        return "cancel";
      }
      if (state.extractionMode !== null) {
        state.cancelExtractionSelection();
        return "cancel";
      }
      return "close";
    },
    dispose: () => {
      unsubscribe();
      const state = useMiniEditorStore.getState();
      if (state.isOpen && state._internal.prepare === owner) state.close();
    },
  };
}

/** Installs the first-party workspace canary and its two structural surfaces. */
export function declareMiniEditorWorkspace(): void {
  if (installed) return;

  editorSurfaceRegistry.register({
    id: MINI_EDITOR_PREVIEW_SURFACE_ID,
    title: "MiniEditor preview",
    defaultStage: "main-stage",
    order: 20,
    focusRegion: "miniEditor",
    cancelInteractions: () =>
      useMiniEditorStore.getState().setPlaying(false),
    component: MiniEditorWorkspacePreviewSurface,
  });
  editorSurfaceRegistry.register({
    id: MINI_EDITOR_CONTROLS_SURFACE_ID,
    title: "MiniEditor controls",
    defaultStage: "lower-stage",
    order: 20,
    focusRegion: "miniEditor",
    cancelInteractions: () =>
      useMiniEditorStore.getState().setPlaying(false),
    component: MiniEditorWorkspaceControlsSurface,
  });
  dedicatedWorkspaceRegistry.register<MiniEditorWorkspaceSubject>({
    id: MINI_EDITOR_WORKSPACE_ID,
    title: "Focused asset editor",
    ownerId: "host.mini-editor",
    subjectSchema: { validate: isWorkspaceSubject },
    describeSubject: (subject) => subject.title,
    composition: {
      stages: {
        "main-stage": {
          surfaceId: MINI_EDITOR_PREVIEW_SURFACE_ID,
          required: true,
        },
        "lower-stage": {
          surfaceId: MINI_EDITOR_CONTROLS_SURFACE_ID,
          required: true,
        },
      },
      docks: {
        "left-sidebar": {
          mode: "replace",
          panels: [{ viewId: "host.assets", required: true }],
          selectedViewId: "host.assets",
        },
        "right-sidebar": { mode: "replace", panels: [] },
        "player-aside": { mode: "replace", panels: [] },
        "bottom-dock": { mode: "replace", panels: [] },
      },
    },
    initialFocus: { kind: "stage", stage: "main-stage" },
    createSession: (subject, context) =>
      createWorkspaceSession(subject, context.signal, context.requestClose),
  });
  installed = true;
}

export interface OpenMiniEditorWorkspaceOptions {
  readonly assetId: string;
  readonly title: string;
  readonly args: MiniEditorOpenArgs;
  readonly invocationTarget?: HTMLElement | null;
}

/** One-shot handoff keeps callbacks and Files outside the finite-JSON subject. */
export async function openMiniEditorWorkspace(
  options: OpenMiniEditorWorkspaceOptions,
): Promise<WorkspaceActivationResult> {
  declareMiniEditorWorkspace();
  const launchId = crypto.randomUUID();
  pendingLaunches.set(launchId, {
    args: options.args,
  });
  const result = await dedicatedWorkspaceController.enter(
    MINI_EDITOR_WORKSPACE_ID,
    {
      assetId: options.assetId,
      launchId,
      title: options.title.trim().slice(0, 160) || "Untitled asset",
    },
    options.invocationTarget,
  );
  const abandoned = pendingLaunches.get(launchId);
  pendingLaunches.delete(launchId);
  if (abandoned) abandoned.args.onClose?.();
  return result;
}

/** Feature-owned subject invalidation seam used when an asset is deleted. */
export function invalidateMiniEditorWorkspaceAsset(
  assetId: string,
): Promise<boolean> {
  return dedicatedWorkspaceController.invalidateSubject(
    MINI_EDITOR_WORKSPACE_ID,
    (subject) =>
      typeof subject === "object" &&
      subject !== null &&
      !Array.isArray(subject) &&
      subject.assetId === assetId,
  );
}
