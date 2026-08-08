/** One sampled composited frame, as the scope dock reads it back. */
export interface ScopeFrameSample {
  /** Premultiplied RGBA bytes, row-major, `width * height * 4` long. */
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Host clock reading when the frame was sampled, in milliseconds. */
  readonly sampledAt: number;
}

export interface ScopeRenderTarget {
  /** Host-owned 2D context, cleared before each draw. */
  readonly context: CanvasRenderingContext2D;
  /** Backing pixel size, matching the definition's own request. */
  readonly width: number;
  readonly height: number;
  readonly frame: ScopeFrameSample;
}

export interface ScopeDefinition {
  readonly id: string;
  readonly label: string;
  /**
   * Backing pixel size of the drawing surface. A scope draws a pixel grid
   * (density plots, envelopes), so it states the resolution it wants and the
   * dock scales the result to the available width.
   */
  readonly width: number;
  readonly height: number;
  readonly order: number;
  render(target: ScopeRenderTarget): void;
}

export interface ScopeEntry extends ScopeDefinition {
  readonly source: "host" | "extension";
}

export interface ScopeRegistration {
  dispose(): void;
}

const HOST_SCOPE_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const CONTRIBUTED_SCOPE_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const MAX_LABEL_LENGTH = 40;
export const MIN_SCOPE_SURFACE_PX = 16;
export const MAX_SCOPE_SURFACE_PX = 2_048;

function assertSurface(value: number, id: string, field: string): void {
  if (
    !Number.isInteger(value) ||
    value < MIN_SCOPE_SURFACE_PX ||
    value > MAX_SCOPE_SURFACE_PX
  ) {
    throw new Error(
      `Scope '${id}' ${field} must be an integer between ` +
        `${MIN_SCOPE_SURFACE_PX} and ${MAX_SCOPE_SURFACE_PX}.`,
    );
  }
}

function assertDefinition(
  definition: ScopeDefinition,
  source: "host" | "extension",
): void {
  const pattern =
    source === "host" ? HOST_SCOPE_ID_PATTERN : CONTRIBUTED_SCOPE_ID_PATTERN;
  if (typeof definition.id !== "string" || !pattern.test(definition.id)) {
    throw new Error(`Invalid ${source} scope ID '${String(definition.id)}'.`);
  }
  if (
    typeof definition.label !== "string" ||
    definition.label.trim().length === 0 ||
    definition.label.trim().length > MAX_LABEL_LENGTH
  ) {
    throw new Error(
      `Scope '${definition.id}' label must be 1-${MAX_LABEL_LENGTH} characters.`,
    );
  }
  assertSurface(definition.width, definition.id, "width");
  assertSurface(definition.height, definition.id, "height");
  if (!Number.isFinite(definition.order)) {
    throw new Error(`Scope '${definition.id}' order must be finite.`);
  }
  if (typeof definition.render !== "function") {
    throw new Error(`Scope '${definition.id}' must provide render().`);
  }
}

/**
 * The scope table the dock renders. Native scopes and contributed ones are the
 * same kind of thing — a label and a function that draws one sampled frame into
 * a host-owned 2D context — so they live in one registry and reach the dock
 * through one code path. The registry knows nothing about extension ownership;
 * the adapter qualifies IDs and binds disposal before it registers here.
 */
export class HostScopeRegistry {
  private readonly entries = new Map<string, ScopeEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  registerHostScope(definition: ScopeDefinition): ScopeRegistration {
    return this.registerEntry({ ...definition, source: "host" });
  }

  registerEntry(entry: ScopeEntry): ScopeRegistration {
    assertDefinition(entry, entry.source);
    if (this.entries.has(entry.id)) {
      throw new Error(`Scope '${entry.id}' is already registered.`);
    }
    const frozen: ScopeEntry = Object.freeze({
      ...entry,
      label: entry.label.trim(),
    });
    this.entries.set(entry.id, frozen);
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.entries.get(frozen.id) !== frozen) return;
        this.entries.delete(frozen.id);
        this.emitChange();
      },
    });
  }

  get(id: string): ScopeEntry | undefined {
    return this.entries.get(id);
  }

  list(): readonly ScopeEntry[] {
    return [...this.entries.values()].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    );
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
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Scope observers are derived render notifications only.
      }
    }
  }
}

export const hostScopeRegistry = new HostScopeRegistry();
