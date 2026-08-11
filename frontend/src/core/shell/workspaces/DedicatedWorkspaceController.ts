import type { JsonValue } from "@vlo/extension-sdk";
import { registerProjectClosingHook } from "../../project/projectLifecycleHooks";
import { jsonValueSchema } from "../jsonValue";
import { editorSurfaceRegistry, type EditorSurfaceRegistry } from "../editorSurfaces";
import {
  isDockRegion,
  isEditorStage,
  type DockRegion,
  type EditorStage,
} from "../layout/layoutTypes";
import { useShellLayoutStore } from "../layout/useShellLayoutStore";
import { hostViewRegistry, type HostViewRegistry } from "../viewRegistry";
import {
  dedicatedWorkspaceRegistry,
  type DedicatedWorkspaceRegistry,
} from "./DedicatedWorkspaceRegistry";
import type {
  ActiveDedicatedWorkspace,
  DedicatedWorkspaceEntry,
  DedicatedWorkspaceSession,
  WorkspaceActivationResult,
  WorkspaceComposition,
  WorkspaceDockSlot,
  WorkspaceFocusTarget,
  WorkspaceSurfaceSlot,
} from "./workspaceTypes";

interface WorkspaceLayoutStore {
  getState(): Pick<
    ReturnType<typeof useShellLayoutStore.getState>,
    | "baseLayoutRevision"
    | "panels"
    | "activateWorkspaceLayout"
    | "deactivateWorkspaceLayout"
    | "saveActiveWorkspaceLayoutOverride"
    | "clearWorkspaceLayoutOverride"
  >;
}

interface ActiveRuntime {
  readonly entry: DedicatedWorkspaceEntry;
  readonly publicState: ActiveDedicatedWorkspace;
  readonly session: DedicatedWorkspaceSession;
  readonly abortController: AbortController;
  readonly returnFocus: HTMLElement | null;
}

export interface DedicatedWorkspaceControllerSnapshot {
  readonly active: ActiveDedicatedWorkspace | null;
  readonly transition: "idle" | "opening" | "closing";
  readonly lastError: Error | null;
}

export interface DedicatedWorkspaceControllerOptions {
  readonly registry?: DedicatedWorkspaceRegistry;
  readonly views?: HostViewRegistry;
  readonly surfaces?: EditorSurfaceRegistry;
  readonly layoutStore?: WorkspaceLayoutStore;
  readonly cancelShellInteractions?: () => void;
}

function cancelActiveShellInteractions(): void {
  if (typeof globalThis.dispatchEvent !== "function") return;
  globalThis.dispatchEvent(new Event("pointercancel"));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value === "object" && value !== null) {
    const clone: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneJson(child);
    return clone;
  }
  return value;
}

function isSession(value: unknown): value is DedicatedWorkspaceSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<DedicatedWorkspaceSession>;
  return (
    typeof candidate.dispose === "function" &&
    (candidate.dirty === undefined || typeof candidate.dirty === "boolean") &&
    (candidate.requestClose === undefined ||
      typeof candidate.requestClose === "function")
  );
}

function focusTarget(target: WorkspaceFocusTarget | undefined): void {
  if (!target || typeof globalThis.document === "undefined") return;
  const selector =
    target.kind === "stage"
      ? `[data-shell-stage="${target.stage}"]`
      : `#shell-region-${target.region}`;
  globalThis.document.querySelector<HTMLElement>(selector)?.focus();
}

/**
 * Serializes workspace lifecycle around one atomic layout-store transition.
 * Feature sessions never receive the store or registries themselves.
 */
export class DedicatedWorkspaceController {
  private readonly registry: DedicatedWorkspaceRegistry;
  private readonly views: HostViewRegistry;
  private readonly surfaces: EditorSurfaceRegistry;
  private readonly layoutStore: WorkspaceLayoutStore;
  private readonly cancelShellInteractions: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeRegistry: () => void;
  private activeRuntime: ActiveRuntime | null = null;
  private pendingAbortController: AbortController | null = null;
  private operation = 0;
  private snapshot: DedicatedWorkspaceControllerSnapshot = Object.freeze({
    active: null,
    transition: "idle",
    lastError: null,
  });

  constructor(options: DedicatedWorkspaceControllerOptions = {}) {
    this.registry = options.registry ?? dedicatedWorkspaceRegistry;
    this.views = options.views ?? hostViewRegistry;
    this.surfaces = options.surfaces ?? editorSurfaceRegistry;
    this.layoutStore = options.layoutStore ?? useShellLayoutStore;
    this.cancelShellInteractions =
      options.cancelShellInteractions ?? cancelActiveShellInteractions;
    this.unsubscribeRegistry = this.registry.subscribe(() => {
      const active = this.activeRuntime;
      if (active && this.registry.get(active.entry.id) !== active.entry) {
        void this.exit({ force: true });
      }
    });
  }

  getSnapshot(): DedicatedWorkspaceControllerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enter(
    workspaceId: string,
    subject: unknown,
    invocationTarget?: HTMLElement | null,
  ): Promise<WorkspaceActivationResult> {
    const entry = this.registry.get(workspaceId);
    let detachedSubject: JsonValue;
    let composition: WorkspaceComposition;
    let subjectLabel: string;
    try {
      if (!entry) throw new Error(`Workspace '${workspaceId}' is not registered.`);
      const parsed = jsonValueSchema.safeParse(subject);
      if (!parsed.success) {
        throw new Error(`Workspace '${workspaceId}' subject must be finite JSON.`);
      }
      detachedSubject = cloneJson(parsed.data);
      if (!entry.validateSubject(detachedSubject)) {
        throw new Error(`Workspace '${workspaceId}' rejected its subject.`);
      }
      composition = this.resolveLiveComposition(entry);
      subjectLabel = entry.describeSubject(detachedSubject).trim();
      if (!subjectLabel || subjectLabel.length > 160) {
        throw new Error(
          `Workspace '${workspaceId}' subject label must be 1-160 characters.`,
        );
      }
    } catch (error) {
      return this.fail(error);
    }

    const token = ++this.operation;
    this.pendingAbortController?.abort();
    this.pendingAbortController = null;
    this.publish({ transition: "opening", lastError: null });

    const previous = this.activeRuntime;
    if (previous && !(await this.canClose(previous))) {
      if (token === this.operation) this.publish({ transition: "idle" });
      return { status: "cancelled" };
    }
    if (token !== this.operation) return { status: "cancelled" };

    const abortController = new AbortController();
    this.pendingAbortController = abortController;
    let session: DedicatedWorkspaceSession | null = null;
    try {
      const created = await entry.createSession(detachedSubject, {
        workspaceId,
        signal: abortController.signal,
        requestClose: () => this.exitActive(workspaceId),
      });
      if (!isSession(created)) {
        throw new Error(`Workspace '${workspaceId}' returned an invalid session.`);
      }
      session = created;
      if (
        token !== this.operation ||
        abortController.signal.aborted ||
        this.registry.get(workspaceId) !== entry
      ) {
        await this.disposeSession(session);
        if (token === this.operation) {
          this.pendingAbortController = null;
          this.publish({ transition: "idle" });
        }
        return { status: "cancelled" };
      }

      const returnFocus =
        invocationTarget ??
        (typeof globalThis.document === "undefined" ||
        !(globalThis.document.activeElement instanceof HTMLElement)
          ? null
          : globalThis.document.activeElement);
      this.cancelShellInteractions();
      this.layoutStore
        .getState()
        .activateWorkspaceLayout(workspaceId, composition);
      const publicState: ActiveDedicatedWorkspace = Object.freeze({
        id: workspaceId,
        title: entry.title,
        ownerId: entry.ownerId,
        subject: detachedSubject,
        subjectLabel,
        baseLayoutRevision: this.layoutStore.getState().baseLayoutRevision,
      });
      this.activeRuntime = {
        entry,
        publicState,
        session,
        abortController,
        returnFocus,
      };
      this.pendingAbortController = null;
      this.publish({ active: publicState, transition: "idle", lastError: null });

      if (previous) {
        previous.abortController.abort();
        await this.disposeSession(previous.session);
      }
      globalThis.queueMicrotask(() => focusTarget(entry.initialFocus));
      return { status: "opened" };
    } catch (error) {
      abortController.abort();
      if (session) await this.disposeSession(session);
      if (this.pendingAbortController === abortController) {
        this.pendingAbortController = null;
      }
      if (token !== this.operation) return { status: "cancelled" };
      return this.fail(error);
    }
  }

  async exit(options: { readonly force?: boolean } = {}): Promise<boolean> {
    const token = ++this.operation;
    this.pendingAbortController?.abort();
    this.pendingAbortController = null;
    const active = this.activeRuntime;
    if (!active) {
      this.publish({ transition: "idle" });
      return false;
    }
    this.publish({ transition: "closing", lastError: null });
    if (!options.force && !(await this.canClose(active))) {
      if (token === this.operation) this.publish({ transition: "idle" });
      return false;
    }
    if (token !== this.operation || this.activeRuntime !== active) return false;

    this.layoutStore.getState().deactivateWorkspaceLayout();
    this.activeRuntime = null;
    this.publish({ active: null, transition: "idle", lastError: null });
    active.abortController.abort();
    await this.disposeSession(active.session);
    if (active.returnFocus?.isConnected) {
      globalThis.queueMicrotask(() => active.returnFocus?.focus());
    }
    return true;
  }

  async invalidateSubject(workspaceId: string): Promise<boolean> {
    if (this.activeRuntime?.entry.id !== workspaceId) return false;
    return this.exit({ force: true });
  }

  saveLayoutOverride(): boolean {
    return this.layoutStore.getState().saveActiveWorkspaceLayoutOverride();
  }

  clearLayoutOverride(workspaceId?: string): boolean {
    const id = workspaceId ?? this.activeRuntime?.entry.id;
    return id
      ? this.layoutStore.getState().clearWorkspaceLayoutOverride(id)
      : false;
  }

  dismissError(): void {
    if (this.snapshot.lastError) this.publish({ lastError: null });
  }

  /** Test/application teardown seam. Active sessions are force-closed. */
  dispose(): void {
    this.unsubscribeRegistry();
    this.operation += 1;
    this.pendingAbortController?.abort();
    this.pendingAbortController = null;
    const active = this.activeRuntime;
    this.activeRuntime = null;
    if (active) {
      this.layoutStore.getState().deactivateWorkspaceLayout();
      active.abortController.abort();
      void this.disposeSession(active.session);
    }
    this.listeners.clear();
  }

  private async exitActive(workspaceId: string): Promise<boolean> {
    return this.activeRuntime?.entry.id === workspaceId ? this.exit() : false;
  }

  private async canClose(runtime: ActiveRuntime): Promise<boolean> {
    if (!runtime.session.requestClose) return true;
    try {
      return (await runtime.session.requestClose()) === "close";
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private resolveLiveComposition(
    entry: DedicatedWorkspaceEntry,
  ): WorkspaceComposition {
    const stages: Partial<Record<EditorStage, WorkspaceSurfaceSlot>> = {};
    for (const [stage, slot] of Object.entries(entry.composition.stages ?? {})) {
      if (!slot || !isEditorStage(stage)) continue;
      const surface = this.surfaces.get(slot.surfaceId);
      if (surface && !surface.allowedStages.includes(stage)) {
        throw new Error(
          `Workspace '${entry.id}' cannot mount '${slot.surfaceId}' in '${stage}'.`,
        );
      }
      if (!surface || !this.surfaces.isAvailable(slot.surfaceId)) {
        if (slot.required) {
          throw new Error(
            `Workspace '${entry.id}' requires unavailable surface '${slot.surfaceId}'.`,
          );
        }
        continue;
      }
      stages[stage] = slot;
    }

    const descriptors = new Map(
      this.layoutStore.getState().panels.map((panel) => [panel.id, panel]),
    );
    const docks: Partial<Record<DockRegion, WorkspaceDockSlot>> = {};
    for (const [region, slot] of Object.entries(entry.composition.docks ?? {})) {
      if (!isDockRegion(region)) continue;
      if (!slot || slot.mode === "inherit") {
        if (slot) docks[region] = slot;
        continue;
      }
      const panels = slot.panels.filter((panel) => {
        const descriptor = descriptors.get(panel.viewId);
        const view = this.views.get(panel.viewId);
        if (view && !view.allowedRegions.includes(region)) {
          throw new Error(
            `Workspace '${entry.id}' cannot place '${panel.viewId}' in '${region}'.`,
          );
        }
        if (!view || !descriptor?.available) {
          if (panel.required) {
            throw new Error(
              `Workspace '${entry.id}' requires unavailable panel '${panel.viewId}'.`,
            );
          }
          return false;
        }
        return true;
      });
      const selectedViewId =
        slot.selectedViewId !== undefined &&
        slot.selectedViewId !== null &&
        !panels.some((panel) => panel.viewId === slot.selectedViewId)
          ? undefined
          : slot.selectedViewId;
      docks[region] = {
        mode: slot.mode,
        panels,
        ...(selectedViewId === undefined ? {} : { selectedViewId }),
      };
    }
    return { stages, docks };
  }

  private async disposeSession(session: DedicatedWorkspaceSession): Promise<void> {
    try {
      await session.dispose();
    } catch (error) {
      console.error("[shell] Dedicated workspace disposal failed", error);
    }
  }

  private fail(error: unknown): { readonly status: "failed"; readonly error: Error } {
    const normalized = toError(error);
    this.publish({ transition: "idle", lastError: normalized });
    return { status: "failed", error: normalized };
  }

  private publish(
    patch: Partial<DedicatedWorkspaceControllerSnapshot>,
  ): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Controller observers derive shell chrome only.
      }
    }
  }
}

export const dedicatedWorkspaceController = new DedicatedWorkspaceController();

registerProjectClosingHook(() =>
  dedicatedWorkspaceController.exit({ force: true }).then(() => undefined),
);
