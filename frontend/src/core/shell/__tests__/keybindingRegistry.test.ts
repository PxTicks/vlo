import { describe, expect, it, vi } from "vitest";
import { HostKeybindingRegistry, parseChord } from "../keybindingRegistry";

function keyEvent(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

describe("parseChord", () => {
  it("parses modifiers and keys", () => {
    expect(parseChord("Mod+Shift+K")).toMatchObject({
      mod: true,
      shift: true,
      key: "k",
    });
    expect(parseChord("Ctrl+Alt+ArrowLeft")).toMatchObject({
      ctrl: true,
      alt: true,
      key: "arrowleft",
    });
    expect(parseChord("Space")).toMatchObject({ key: " " });
  });

  it.each(["", "Mod+", "Mod+K+J", "Ctrl+Shift"])(
    "rejects malformed chords: %s",
    (chord) => {
      expect(() => parseChord(chord)).toThrow();
    },
  );
});

describe("HostKeybindingRegistry", () => {
  it("dispatches to region-matching bindings and prevents default", () => {
    const registry = new HostKeybindingRegistry(() => false);
    registry.registerHostDefault({
      id: "host.delete",
      chord: "Delete",
      commandId: "timeline.clip.delete",
      regions: ["timeline"],
    });

    const execute = vi.fn(() => true);
    const timelineEvent = keyEvent({ key: "Delete" });
    expect(registry.dispatch(timelineEvent, "timeline", execute)).toBe(true);
    expect(execute).toHaveBeenCalledWith("timeline.clip.delete");
    expect(timelineEvent.defaultPrevented).toBe(true);

    // Wrong region: the binding must not fire.
    execute.mockClear();
    expect(registry.dispatch(keyEvent({ key: "Delete" }), "canvas", execute)).toBe(
      false,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves Mod per platform", () => {
    const macRegistry = new HostKeybindingRegistry(() => true);
    macRegistry.registerHostDefault({
      id: "host.save",
      chord: "Mod+S",
      commandId: "app.save",
    });
    const execute = vi.fn(() => true);
    expect(
      macRegistry.dispatch(keyEvent({ key: "s", metaKey: true }), null, execute),
    ).toBe(true);
    expect(
      macRegistry.dispatch(keyEvent({ key: "s", ctrlKey: true }), null, execute),
    ).toBe(false);
  });

  it("does not dispatch from editable targets or handled events", () => {
    const registry = new HostKeybindingRegistry(() => false);
    registry.registerHostDefault({
      id: "host.go",
      chord: "G",
      commandId: "app.go",
    });
    const execute = vi.fn(() => true);

    const input = document.createElement("input");
    document.body.appendChild(input);
    const inputEvent = keyEvent({ key: "g" });
    Object.defineProperty(inputEvent, "target", { value: input });
    expect(registry.dispatch(inputEvent, null, execute)).toBe(false);

    const handled = keyEvent({ key: "g" });
    handled.preventDefault();
    expect(registry.dispatch(handled, null, execute)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    input.remove();
  });

  it("skips bindings whose command refuses execution", () => {
    const registry = new HostKeybindingRegistry(() => false);
    registry.registerHostDefault({
      id: "host.disabled",
      chord: "G",
      commandId: "app.disabled",
    });
    const execute = vi.fn(() => false);
    const event = keyEvent({ key: "g" });
    expect(registry.dispatch(event, null, execute)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("shadows colliding contributed bindings with a diagnostic and reactivates on disposal", () => {
    const registry = new HostKeybindingRegistry(() => false);
    const onDiagnostic = vi.fn();
    const host = registry.registerHostDefault({
      id: "host.mute",
      chord: "M",
      commandId: "timeline.clip.toggle-mute",
    });
    registry.registerContributedBinding({
      id: "example.keys/mute",
      chord: "m",
      commandId: "example.keys/mute",
      onDiagnostic,
    });

    expect(registry.list().map((entry) => [entry.id, entry.active])).toEqual([
      ["host.mute", true],
      ["example.keys/mute", false],
    ]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("shadowed"),
    );

    host.dispose();
    expect(registry.list().map((entry) => [entry.id, entry.active])).toEqual([
      ["example.keys/mute", true],
    ]);
  });

  it("reservations shadow contributed bindings but never dispatch themselves", () => {
    const registry = new HostKeybindingRegistry(() => false);
    const onDiagnostic = vi.fn();
    registry.reserveHostChord({
      id: "host.undo",
      chord: "Mod+Z",
    });
    registry.registerContributedBinding({
      id: "example.keys/steal-undo",
      chord: "Ctrl+Z",
      commandId: "example.keys/steal-undo",
      onDiagnostic,
    });

    // The colliding contributed binding is inactive with a diagnostic.
    expect(registry.list().map((entry) => [entry.id, entry.active])).toEqual([
      ["host.undo", true],
      ["example.keys/steal-undo", false],
    ]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("shadowed"),
    );

    // The reservation itself never executes or preventDefaults; the inline
    // host handler owns the chord.
    const execute = vi.fn(() => true);
    const event = keyEvent({ key: "z", ctrlKey: true });
    expect(registry.dispatch(event, "timeline", execute)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("validates binding IDs and regions", () => {
    const registry = new HostKeybindingRegistry(() => false);
    expect(() =>
      registry.registerHostDefault({
        id: "Bad ID",
        chord: "G",
        commandId: "a.b",
      }),
    ).toThrow(/Invalid keybinding ID/);
    expect(() =>
      registry.reserveHostChord({
        id: "host.x",
        chord: "G",
        regions: ["sidebar"],
      }),
    ).toThrow(/unknown region/);
    expect(() =>
      registry.reserveHostChord({ id: "host.y", chord: "G", regions: [] }),
    ).toThrow(/non-empty/);
    // Contributed bindings arrive pre-qualified; anything else is a
    // contributing-layer bug the shell rejects loudly.
    expect(() =>
      registry.registerContributedBinding({
        id: "unqualified",
        chord: "G",
        commandId: "example.keys/x",
      }),
    ).toThrow(/owner-qualified/);
  });

  it("keeps disjoint-region bindings on one chord both active", () => {
    const registry = new HostKeybindingRegistry(() => false);
    registry.registerHostDefault({
      id: "host.timeline",
      chord: "X",
      commandId: "a.b",
      regions: ["timeline"],
    });
    registry.registerContributedBinding({
      id: "example.keys/canvas",
      chord: "X",
      commandId: "example.keys/c",
      regions: ["canvas"],
    });
    expect(registry.list().every((entry) => entry.active)).toBe(true);

    const execute = vi.fn(() => true);
    registry.dispatch(keyEvent({ key: "x" }), "canvas", execute);
    expect(execute).toHaveBeenCalledWith("example.keys/c");
  });
});
