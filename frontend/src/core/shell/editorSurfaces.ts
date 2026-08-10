/**
 * Registry of editor surfaces — the editor's primary working areas, as opposed
 * to the dock panels that surround them
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §3.1, §4.1).
 *
 * A surface occupies a whole stage: `main-stage` holds the picture,
 * `lower-stage` holds the timeline. Exactly one surface is mounted per stage,
 * which is what lets a dedicated workspace swap the editor's centre without any
 * feature reaching into the layout.
 *
 * Host-only by design (plan §6): the top bar, project navigation, and the
 * workspace exit control stay non-replaceable escape chrome, and extensions do
 * not get to replace the editor's centre until at least one native canary has
 * proven the lifecycle.
 */
import type { ReactNode } from "react";
import type { ExtensionContextKeyExpression } from "@vlo/extension-sdk";
import {
  assertContextKeyExpression,
  hostContextKeys,
  type HostContextKeyService,
} from "./contextKeys";
import type { EditorRegion } from "./editorRegions";
import { EDITOR_STAGES, isEditorStage, type EditorStage } from "./layout/layoutTypes";
import type { ShellDisposable } from "./hostMenuCatalog";

export interface EditorSurfaceComponentProps {
  readonly surfaceId: string;
  readonly stage: EditorStage;
}

export interface EditorSurfaceDefinition {
  readonly id: string;
  /** Names the surface in stage chrome, move menus, and error boundaries. */
  readonly title: string;
  readonly defaultStage: EditorStage;
  /**
   * Stages a workspace may mount this surface in. Must contain `defaultStage`.
   * Omitted means the surface only ever appears where it registered.
   */
  readonly allowedStages?: readonly EditorStage[];
  /** Tie-breaker when several surfaces default to the same stage. */
  readonly order?: number;
  readonly when?: ExtensionContextKeyExpression;
  /**
   * Keyboard region this surface owns while it is mounted. The stage mount
   * claims it on pointer interaction and releases it on removal.
   */
  readonly focusRegion?: EditorRegion;
  /**
   * Ends every pointer-driven interaction the surface owns — drags, trims,
   * pointer captures — before the shell stops rendering it (plan §4.8).
   *
   * Must be idempotent and safe to call when nothing is in flight: the shell
   * calls it both when a stage's surface is swapped and when the mount goes
   * away, and those can be the same transition.
   */
  readonly cancelInteractions?: () => void;
  readonly component: (props: EditorSurfaceComponentProps) => ReactNode;
}

export interface EditorSurfaceEntry extends EditorSurfaceDefinition {
  readonly order: number;
  /** Normalized, deduplicated, and ordered by `EDITOR_STAGES`. */
  readonly allowedStages: readonly EditorStage[];
}

const SURFACE_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;

function normalizeAllowedStages(
  definition: EditorSurfaceDefinition,
  id: string,
): readonly EditorStage[] {
  const { allowedStages, defaultStage } = definition;
  if (allowedStages === undefined) return Object.freeze([defaultStage]);
  if (!Array.isArray(allowedStages) || allowedStages.length === 0) {
    throw new Error(`Surface '${id}' allowedStages must be a non-empty array.`);
  }
  for (const stage of allowedStages) {
    if (!isEditorStage(stage)) {
      throw new Error(`Surface '${id}' cannot be mounted in stage '${stage}'.`);
    }
  }
  if (!allowedStages.includes(defaultStage)) {
    throw new Error(
      `Surface '${id}' allowedStages must include its default stage '${defaultStage}'.`,
    );
  }
  // Canonical order keeps menus and descriptor comparisons stable no matter how
  // the registration happened to spell the list.
  return Object.freeze(
    EDITOR_STAGES.filter((stage) => allowedStages.includes(stage)),
  );
}

/** Shell-owned surface table. Mirrors `HostViewRegistry`'s ownership rules. */
export class EditorSurfaceRegistry {
  private readonly entries = new Map<string, EditorSurfaceEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly contextKeys: HostContextKeyService;
  private revision = 0;

  constructor(contextKeys: HostContextKeyService = hostContextKeys) {
    this.contextKeys = contextKeys;
  }

  register(definition: EditorSurfaceDefinition): ShellDisposable {
    const { id } = definition;
    if (!SURFACE_ID_PATTERN.test(id) || !id.includes(".")) {
      throw new Error(`Invalid editor surface ID '${id}'.`);
    }
    if (this.entries.has(id)) {
      throw new Error(`Editor surface '${id}' is already registered.`);
    }
    if (!isEditorStage(definition.defaultStage)) {
      throw new Error(
        `Surface '${id}' targets unsupported stage '${definition.defaultStage}'.`,
      );
    }
    if (typeof definition.component !== "function") {
      throw new Error(`Surface '${id}' must provide a component function.`);
    }
    if (
      definition.cancelInteractions !== undefined &&
      typeof definition.cancelInteractions !== "function"
    ) {
      throw new Error(`Surface '${id}' cancelInteractions must be a function.`);
    }
    if (typeof definition.title !== "string" || definition.title.trim() === "") {
      throw new Error(`Surface '${id}' title must be a non-empty string.`);
    }
    if (definition.when !== undefined) {
      assertContextKeyExpression(definition.when, `Surface '${id}'`);
    }
    const order = definition.order ?? 0;
    if (!Number.isFinite(order)) {
      throw new Error(`Surface '${id}' order must be finite.`);
    }
    const entry: EditorSurfaceEntry = Object.freeze({
      ...definition,
      title: definition.title.trim(),
      order,
      allowedStages: normalizeAllowedStages(definition, id),
    });
    this.entries.set(id, entry);
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.entries.get(id) !== entry) return;
        this.entries.delete(id);
        this.emitChange();
      },
    });
  }

  get(surfaceId: string): EditorSurfaceEntry | undefined {
    return this.entries.get(surfaceId);
  }

  /** Registration order is not meaningful; callers sort by `order` then ID. */
  list(): readonly EditorSurfaceEntry[] {
    return [...this.entries.values()];
  }

  /** Evaluates the surface's declarative availability condition. */
  isAvailable(surfaceId: string): boolean {
    const entry = this.entries.get(surfaceId);
    if (!entry) return false;
    return entry.when === undefined || this.contextKeys.evaluate(entry.when);
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
        // Surface observers are derived render notifications only.
      }
    }
  }
}

export const editorSurfaceRegistry = new EditorSurfaceRegistry();

/**
 * Runs one surface's canceller, containing a failure.
 *
 * A surface that cannot clean up must not block the shell from replacing it —
 * that would strand the user in the layout they asked to leave, and from a
 * React cleanup the throw would escape past the surface's own error boundary
 * and take the editor down. Callers that already hold the entry use this
 * directly, because a surface being unregistered is gone from the registry by
 * the time its mount tears down.
 */
export function runEditorSurfaceCanceller(entry: EditorSurfaceEntry): void {
  if (!entry.cancelInteractions) return;
  try {
    entry.cancelInteractions();
  } catch (error) {
    console.error(`[shell] Surface '${entry.id}' failed to cancel`, error);
  }
}

/**
 * Ends whatever a surface was in the middle of, without the caller having to
 * know the surface exists. A missing surface, or one that owns no pointer
 * interactions, cancels to nothing.
 */
export function cancelEditorSurfaceInteractions(
  surfaceId: string,
  registry: EditorSurfaceRegistry = editorSurfaceRegistry,
): void {
  const entry = registry.get(surfaceId);
  if (entry) runEditorSurfaceCanceller(entry);
}
