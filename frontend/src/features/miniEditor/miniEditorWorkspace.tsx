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
  readonly assetId: string;
  readonly args: MiniEditorOpenArgs;
}

const pendingLaunches = new Map<string, PendingLaunch>();
const liveLaunchAssets = new Map<string, string>();
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
    throw new Error(`MiniEditor launch '${subject.launchId}' is no longer available.`);
  }
  pendingLaunches.delete(subject.launchId);
  liveLaunchAssets.set(subject.launchId, subject.assetId);
  const args: MiniEditorOpenArgs = {
    ...launch.args,
    presentation: "workspace",
  };
  const owner = args.prepare;
  await waitForOpenOrAbort(useMiniEditorStore.getState().open(args), signal);

  const unsubscribe = useMiniEditorStore.subscribe((state, previous) => {
    if (
      previous.isOpen &&
      previous._internal.prepare === owner &&
      (!state.isOpen ||
        (state._internal.prepare !== owner && state.presentation === "modal"))
    ) {
      void requestClose();
    }
  });

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
      liveLaunchAssets.delete(subject.launchId);
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
    focusRegion: "canvas",
    cancelInteractions: () =>
      useMiniEditorStore.getState().setPlaying(false),
    component: MiniEditorWorkspacePreviewSurface,
  });
  editorSurfaceRegistry.register({
    id: MINI_EDITOR_CONTROLS_SURFACE_ID,
    title: "MiniEditor controls",
    defaultStage: "lower-stage",
    order: 20,
    focusRegion: "timeline",
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
        // Keep the invoking asset browser mounted for previous/next navigation;
        // the project timeline and unrelated supporting docks still disappear.
        "left-sidebar": { mode: "inherit" },
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
    assetId: options.assetId,
    args: options.args,
  });
  const result = await dedicatedWorkspaceController.enter(
    MINI_EDITOR_WORKSPACE_ID,
    { assetId: options.assetId, launchId, title: options.title },
    options.invocationTarget,
  );
  const abandoned = pendingLaunches.get(launchId);
  pendingLaunches.delete(launchId);
  if (abandoned) abandoned.args.onClose?.();
  return result;
}

/** Feature-owned subject invalidation seam used when an asset is deleted. */
export function invalidateMiniEditorWorkspaceAsset(assetId: string): Promise<boolean> {
  const active = dedicatedWorkspaceController.getSnapshot().active;
  const subject = active?.subject;
  if (
    active?.id === MINI_EDITOR_WORKSPACE_ID &&
    typeof subject === "object" &&
    subject !== null &&
    !Array.isArray(subject) &&
    subject.assetId === assetId
  ) {
    return dedicatedWorkspaceController.invalidateSubject(MINI_EDITOR_WORKSPACE_ID);
  }
  for (const [launchId, launch] of pendingLaunches) {
    if (launch.assetId !== assetId) continue;
    pendingLaunches.delete(launchId);
    launch.args.onClose?.();
    return dedicatedWorkspaceController
      .exit({ force: true })
      .then(() => true);
  }
  for (const liveAssetId of liveLaunchAssets.values()) {
    if (liveAssetId !== assetId) continue;
    return dedicatedWorkspaceController.exit({ force: true }).then(() => true);
  }
  return Promise.resolve(false);
}
