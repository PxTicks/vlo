import {
  DOCK_REGIONS,
  EDITOR_STAGES,
  isDockRegion,
  isEditorStage,
  type DockRegion,
} from "../layout/layoutTypes";
import type { ShellDisposable } from "../hostMenuCatalog";
import type {
  DedicatedWorkspaceDefinition,
  DedicatedWorkspaceContext,
  DedicatedWorkspaceEntry,
  WorkspaceComposition,
  WorkspaceDockSlot,
} from "./workspaceTypes";
import type { JsonValue } from "@vlo/extension-sdk";

const WORKSPACE_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const SHELL_ITEM_ID_PATTERN =
  /^[a-z0-9](?:[/a-z0-9._-]*[a-z0-9])?$/;
const OWNER_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/;
const MAX_TITLE_LENGTH = 80;

function assertWorkspaceId(value: string): void {
  if (!WORKSPACE_ID_PATTERN.test(value) || !value.includes(".")) {
    throw new Error(`Invalid workspace ID '${value}'.`);
  }
}

function assertShellItemId(value: string, label: string): void {
  if (!SHELL_ITEM_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} '${value}'.`);
  }
}

function normalizeComposition(
  workspaceId: string,
  composition: WorkspaceComposition,
): WorkspaceComposition {
  if (typeof composition !== "object" || composition === null) {
    throw new Error(`Workspace '${workspaceId}' must declare a composition.`);
  }
  for (const stage of Object.keys(composition.stages ?? {})) {
    if (!isEditorStage(stage)) {
      throw new Error(
        `Workspace '${workspaceId}' targets unsupported stage '${stage}'.`,
      );
    }
  }
  for (const region of Object.keys(composition.docks ?? {})) {
    if (!isDockRegion(region)) {
      throw new Error(
        `Workspace '${workspaceId}' targets unsupported dock '${region}'.`,
      );
    }
  }
  const seenSurfaces = new Set<string>();
  const stages: Record<string, { surfaceId: string; required?: boolean }> = {};
  for (const stage of EDITOR_STAGES) {
    const slot = composition.stages?.[stage];
    if (!slot) continue;
    assertShellItemId(slot.surfaceId, "editor surface ID");
    if (seenSurfaces.has(slot.surfaceId)) {
      throw new Error(
        `Workspace '${workspaceId}' mounts surface '${slot.surfaceId}' more than once.`,
      );
    }
    seenSurfaces.add(slot.surfaceId);
    stages[stage] = Object.freeze({
      surfaceId: slot.surfaceId,
      ...(slot.required === true ? { required: true } : {}),
    });
  }

  const seenPanels = new Set<string>();
  const docks: Partial<Record<DockRegion, WorkspaceDockSlot>> = {};
  for (const region of DOCK_REGIONS) {
    const slot = composition.docks?.[region];
    if (!slot) continue;
    if (slot.mode === "inherit") {
      docks[region] = Object.freeze({ mode: "inherit" });
      continue;
    }
    if (slot.mode !== "augment" && slot.mode !== "replace") {
      throw new Error(
        `Workspace '${workspaceId}' uses an invalid dock mode in '${region}'.`,
      );
    }
    if (!Array.isArray(slot.panels)) {
      throw new Error(
        `Workspace '${workspaceId}' dock '${region}' must declare panels.`,
      );
    }
    const panels = slot.panels.map((panel) => {
      assertShellItemId(panel.viewId, "panel ID");
      if (seenPanels.has(panel.viewId)) {
        throw new Error(
          `Workspace '${workspaceId}' places panel '${panel.viewId}' more than once.`,
        );
      }
      seenPanels.add(panel.viewId);
      return Object.freeze({
        viewId: panel.viewId,
        ...(panel.required === true ? { required: true } : {}),
      });
    });
    if (
      slot.selectedViewId !== undefined &&
      slot.selectedViewId !== null &&
      !panels.some((panel) => panel.viewId === slot.selectedViewId)
    ) {
      throw new Error(
        `Workspace '${workspaceId}' selects a panel not listed in '${region}'.`,
      );
    }
    docks[region] = Object.freeze({
      mode: slot.mode,
      panels: Object.freeze(panels),
      ...(slot.selectedViewId === undefined
        ? {}
        : { selectedViewId: slot.selectedViewId }),
    });
  }

  return Object.freeze({
    stages: Object.freeze(stages),
    docks: Object.freeze(docks),
  });
}

/** Host-only registry for subject-bound editor compositions. */
export class DedicatedWorkspaceRegistry {
  private readonly entries = new Map<string, DedicatedWorkspaceEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  register<TSubject>(
    definition: DedicatedWorkspaceDefinition<TSubject>,
  ): ShellDisposable {
    assertWorkspaceId(definition.id);
    if (this.entries.has(definition.id)) {
      throw new Error(`Workspace '${definition.id}' is already registered.`);
    }
    if (
      typeof definition.ownerId !== "string" ||
      !OWNER_ID_PATTERN.test(definition.ownerId)
    ) {
      throw new Error(`Workspace '${definition.id}' has an invalid owner ID.`);
    }
    const title = definition.title?.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw new Error(
        `Workspace '${definition.id}' title must be 1-${MAX_TITLE_LENGTH} characters.`,
      );
    }
    if (typeof definition.subjectSchema?.validate !== "function") {
      throw new Error(`Workspace '${definition.id}' must declare a subject schema.`);
    }
    if (typeof definition.describeSubject !== "function") {
      throw new Error(`Workspace '${definition.id}' must describe its subject.`);
    }
    if (typeof definition.createSession !== "function") {
      throw new Error(`Workspace '${definition.id}' must create a session.`);
    }
    if (definition.icon !== undefined && typeof definition.icon !== "function") {
      throw new Error(`Workspace '${definition.id}' icon must be a function.`);
    }
    if (
      definition.initialFocus !== undefined &&
      definition.initialFocus.kind !== "stage" &&
      definition.initialFocus.kind !== "dock"
    ) {
      throw new Error(`Workspace '${definition.id}' has an invalid focus target.`);
    }
    if (
      definition.initialFocus?.kind === "stage" &&
      !isEditorStage(definition.initialFocus.stage)
    ) {
      throw new Error(`Workspace '${definition.id}' has an invalid focus stage.`);
    }
    if (
      definition.initialFocus?.kind === "dock" &&
      !isDockRegion(definition.initialFocus.region)
    ) {
      throw new Error(`Workspace '${definition.id}' has an invalid focus dock.`);
    }

    const entry: DedicatedWorkspaceEntry = Object.freeze({
      id: definition.id,
      title,
      ownerId: definition.ownerId,
      ...(definition.icon ? { icon: definition.icon } : {}),
      composition: normalizeComposition(definition.id, definition.composition),
      ...(definition.initialFocus
        ? { initialFocus: Object.freeze({ ...definition.initialFocus }) }
        : {}),
      validateSubject: (subject: JsonValue) =>
        definition.subjectSchema.validate(subject),
      describeSubject: (subject: JsonValue) =>
        definition.describeSubject(subject as TSubject),
      createSession: (subject: JsonValue, context: DedicatedWorkspaceContext) =>
        definition.createSession(subject as TSubject, context),
    });
    this.entries.set(entry.id, entry);
    this.emitChange();

    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.entries.get(entry.id) !== entry) return;
        this.entries.delete(entry.id);
        this.emitChange();
      },
    });
  }

  get(workspaceId: string): DedicatedWorkspaceEntry | undefined {
    return this.entries.get(workspaceId);
  }

  list(): readonly DedicatedWorkspaceEntry[] {
    return [...this.entries.values()];
  }

  disposeOwner(ownerId: string): void {
    let changed = false;
    for (const [workspaceId, entry] of this.entries) {
      if (entry.ownerId !== ownerId) continue;
      this.entries.delete(workspaceId);
      changed = true;
    }
    if (changed) this.emitChange();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Registry listeners derive controller and React state only.
      }
    }
  }
}

export const dedicatedWorkspaceRegistry = new DedicatedWorkspaceRegistry();
