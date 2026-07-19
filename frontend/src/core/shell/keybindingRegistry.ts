import { EDITOR_REGIONS } from "./editorRegions";
import type { ExtensionDisposable } from "@vlo/extension-sdk";

const BINDING_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const KNOWN_REGIONS: ReadonlySet<string> = new Set(EDITOR_REGIONS);

const MODIFIER_TOKENS = new Set([
  "mod",
  "ctrl",
  "control",
  "cmd",
  "command",
  "meta",
  "shift",
  "alt",
  "option",
]);

export interface ParsedChord {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Lowercased `KeyboardEvent.key` value ("k", "delete", "arrowleft", " "). */
  readonly key: string;
}

export function parseChord(chord: string): ParsedChord {
  const tokens = chord.split("+").map((token) => token.trim());
  if (tokens.some((token) => token.length === 0)) {
    throw new Error(`Invalid keybinding chord '${chord}'.`);
  }
  let mod = false;
  let ctrl = false;
  let meta = false;
  let shift = false;
  let alt = false;
  let key: string | null = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (MODIFIER_TOKENS.has(lower)) {
      if (lower === "mod") mod = true;
      else if (lower === "ctrl" || lower === "control") ctrl = true;
      else if (lower === "cmd" || lower === "command" || lower === "meta")
        meta = true;
      else if (lower === "shift") shift = true;
      else alt = true;
      continue;
    }
    if (key !== null) {
      throw new Error(`Keybinding chord '${chord}' has multiple keys.`);
    }
    key = lower === "space" ? " " : lower;
  }
  if (key === null) {
    throw new Error(`Keybinding chord '${chord}' has no key.`);
  }
  return Object.freeze({ mod, ctrl, meta, shift, alt, key });
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad/i.test(navigator.platform ?? "");
}

interface ResolvedChord {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
}

function resolveChord(chord: ParsedChord, isMac: boolean): ResolvedChord {
  return {
    ctrl: chord.ctrl || (chord.mod && !isMac),
    meta: chord.meta || (chord.mod && isMac),
    shift: chord.shift,
    alt: chord.alt,
    key: chord.key,
  };
}

function resolvedChordKey(chord: ResolvedChord): string {
  return [
    chord.ctrl ? "ctrl" : "",
    chord.meta ? "meta" : "",
    chord.alt ? "alt" : "",
    chord.shift ? "shift" : "",
    chord.key,
  ].join("+");
}

export interface RegisteredKeybinding {
  readonly id: string;
  readonly source: "host" | "contributed";
  readonly chord: ParsedChord;
  readonly chordLabel: string;
  /** Fully qualified command ID, or null for a host chord reservation. */
  readonly commandId: string | null;
  /** Editor focus regions the binding is active in; null = global. */
  readonly regions: readonly string[] | null;
  /** False when shadowed by an earlier colliding binding. */
  readonly active: boolean;
}

/**
 * A non-host binding whose owner-scoped policy (ID qualification, ownership,
 * diagnostic routing) was already applied by the contributing layer — the
 * shell never sees owner scopes (§3.10 review finding 3).
 */
export interface ContributedKeybinding {
  /** Already owner-qualified binding ID (`owner/local`). */
  readonly id: string;
  readonly chord: string;
  /** Fully qualified command ID. */
  readonly commandId: string;
  readonly regions?: readonly string[];
  /** Receives this binding's shadowing diagnostics, if anyone listens. */
  readonly onDiagnostic?: (message: string) => void;
}

interface KeybindingEntry {
  readonly id: string;
  readonly source: "host" | "contributed";
  readonly chord: ParsedChord;
  readonly chordLabel: string;
  readonly commandId: string | null;
  readonly regions: readonly string[] | null;
  readonly onDiagnostic?: (message: string) => void;
  active: boolean;
}

function assertBindingShape(binding: {
  readonly id: string;
  readonly regions?: readonly string[];
}): void {
  if (!BINDING_ID_PATTERN.test(binding.id)) {
    throw new Error(`Invalid keybinding ID '${binding.id}'.`);
  }
  if (binding.regions !== undefined) {
    if (binding.regions.length === 0) {
      throw new Error(
        `Keybinding '${binding.id}' regions must be omitted or non-empty.`,
      );
    }
    for (const region of binding.regions) {
      if (!KNOWN_REGIONS.has(region)) {
        throw new Error(
          `Keybinding '${binding.id}' targets unknown region '${region}'.`,
        );
      }
    }
  }
}

function regionsOverlap(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) return true;
  return left.some((region) => right.includes(region));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The single chord table behind command dispatch. Host defaults and
 * contributed bindings share it; a binding that collides with an earlier
 * active binding on the same platform-resolved chord (with overlapping
 * regions) registers as inactive with a diagnostic, so a chord never has two
 * owners at dispatch and a contributed collision never fails registration.
 */
export class HostKeybindingRegistry {
  private readonly entries: KeybindingEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly isMac: () => boolean;

  constructor(isMac: () => boolean = isMacPlatform) {
    this.isMac = isMac;
  }

  registerHostDefault(binding: {
    readonly id: string;
    readonly chord: string;
    readonly commandId: string;
    readonly regions?: readonly string[];
  }): ExtensionDisposable {
    assertBindingShape(binding);
    return this.add({
      id: binding.id,
      source: "host",
      chord: parseChord(binding.chord),
      chordLabel: binding.chord,
      commandId: binding.commandId,
      regions: binding.regions ? [...binding.regions] : null,
      active: true,
    });
  }

  /**
   * Reserves a chord owned by an inline host handler that has not (yet) been
   * routed through the command table. Reservations never dispatch — the inline
   * handler keeps its behaviour — but they participate in collision shadowing,
   * so a contributed binding on a reserved chord registers inactive with a
   * diagnostic instead of double-firing behind the host handler.
   */
  reserveHostChord(binding: {
    readonly id: string;
    readonly chord: string;
    readonly regions?: readonly string[];
  }): ExtensionDisposable {
    assertBindingShape(binding);
    return this.add({
      id: binding.id,
      source: "host",
      chord: parseChord(binding.chord),
      chordLabel: binding.chord,
      commandId: null,
      regions: binding.regions ? [...binding.regions] : null,
      active: true,
    });
  }

  registerContributedBinding(binding: ContributedKeybinding): ExtensionDisposable {
    const segments = binding.id.split("/");
    if (
      segments.length !== 2 ||
      !segments.every((segment) => BINDING_ID_PATTERN.test(segment))
    ) {
      throw new Error(
        `Contributed keybinding ID '${binding.id}' must be owner-qualified ('owner/local').`,
      );
    }
    assertBindingShape({ id: segments[1], regions: binding.regions });
    return this.add({
      id: binding.id,
      source: "contributed",
      chord: parseChord(binding.chord),
      chordLabel: binding.chord,
      commandId: binding.commandId,
      regions: binding.regions ? [...binding.regions] : null,
      onDiagnostic: binding.onDiagnostic,
      active: true,
    });
  }

  list(): readonly RegisteredKeybinding[] {
    return this.entries.map((entry) => Object.freeze({ ...entry }));
  }

  /**
   * Routes one key event to the first active, region-matching binding whose
   * command the executor accepts. Editable targets never dispatch, so bindings
   * cannot swallow typing.
   */
  dispatch(
    event: KeyboardEvent,
    region: string | null,
    execute: (commandId: string) => boolean,
  ): boolean {
    if (event.defaultPrevented) return false;
    if (isEditableTarget(event.target)) return false;
    const isMac = this.isMac();
    const eventKey = event.key.toLowerCase();
    for (const entry of this.entries) {
      // Reservations block contributed bindings at registration; the inline
      // host handler, not the registry, owns the chord's behaviour.
      if (!entry.active || entry.commandId === null) continue;
      const resolved = resolveChord(entry.chord, isMac);
      if (
        resolved.key !== eventKey ||
        resolved.ctrl !== event.ctrlKey ||
        resolved.meta !== event.metaKey ||
        resolved.shift !== event.shiftKey ||
        resolved.alt !== event.altKey
      ) {
        continue;
      }
      if (
        entry.regions !== null &&
        (region === null || !entry.regions.includes(region))
      ) {
        continue;
      }
      if (!execute(entry.commandId)) continue;
      event.preventDefault();
      return true;
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private add(entry: KeybindingEntry): ExtensionDisposable {
    if (this.entries.some((existing) => existing.id === entry.id)) {
      throw new Error(`Keybinding '${entry.id}' is already registered.`);
    }
    this.entries.push(entry);
    this.recomputeActivation();
    this.emitChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const index = this.entries.indexOf(entry);
        if (index === -1) return;
        this.entries.splice(index, 1);
        this.recomputeActivation();
        this.emitChange();
      },
    });
  }

  /**
   * Host bindings shadow contributed bindings; earlier registrations shadow
   * later ones. Re-run on every change so disposing a shadowing binding
   * reactivates what it shadowed.
   */
  private recomputeActivation(): void {
    const isMac = this.isMac();
    const ordered = [...this.entries].sort((left, right) =>
      left.source === right.source ? 0 : left.source === "host" ? -1 : 1,
    );
    const activated: KeybindingEntry[] = [];
    for (const entry of ordered) {
      const key = resolvedChordKey(resolveChord(entry.chord, isMac));
      const shadowedBy = activated.find(
        (active) =>
          resolvedChordKey(resolveChord(active.chord, isMac)) === key &&
          regionsOverlap(active.regions, entry.regions),
      );
      const nextActive = shadowedBy === undefined;
      if (!nextActive && entry.active && entry.onDiagnostic) {
        entry.onDiagnostic(
          `Keybinding '${entry.id}' (${entry.chordLabel}) is shadowed by '${shadowedBy.id}' and will not dispatch.`,
        );
      }
      entry.active = nextActive;
      if (nextActive) activated.push(entry);
    }
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Keybinding observers are derived notifications only.
      }
    }
  }
}

export const hostKeybindingRegistry = new HostKeybindingRegistry();
