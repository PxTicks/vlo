import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { createExtensionSelectionApi } from "../createExtensionSelectionApi";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import type { TimelineClip, Transition } from "../../../../types/TimelineTypes";

function createScope(): ExtensionApiScope {
  return {
    extension: { id: "example.selecting", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function clip(id: string, type: TimelineClip["type"]): TimelineClip {
  return {
    id,
    trackId: "track-1",
    type,
    name: id,
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
  } as unknown as TimelineClip;
}

describe("extension selection writes", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      clips: [
        clip("clip-a", "video"),
        clip("clip-b", "video"),
        clip("clip-a::mask::m1", "mask"),
      ],
      transitions: [{ id: "transition-1" } as unknown as Transition],
      selectedClipIds: [],
      selectedTransitionId: null,
    });
  });

  it("replaces the selection and reports whether anything changed", () => {
    const api = createExtensionSelectionApi(createScope());

    expect(api.setClips(["clip-b", "clip-a"])).toEqual({
      ok: true,
      changed: true,
    });
    expect(api.get()).toEqual({
      clipIds: ["clip-b", "clip-a"],
      transitionId: null,
    });

    // Same set, same order: no change.
    expect(api.setClips(["clip-b", "clip-a"])).toEqual({
      ok: true,
      changed: false,
    });
    // Order is part of the selection, so reversing it is a change.
    expect(api.setClips(["clip-a", "clip-b"])).toEqual({
      ok: true,
      changed: true,
    });

    expect(api.setClips([])).toEqual({ ok: true, changed: true });
    expect(api.get().clipIds).toEqual([]);
  });

  it("deduplicates repeated IDs while preserving order", () => {
    const api = createExtensionSelectionApi(createScope());
    expect(api.setClips(["clip-b", "clip-a", "clip-b"])).toEqual({
      ok: true,
      changed: true,
    });
    expect(api.get().clipIds).toEqual(["clip-b", "clip-a"]);
  });

  it("refuses the whole request for an unknown or unselectable clip", () => {
    const api = createExtensionSelectionApi(createScope());
    api.setClips(["clip-a"]);

    expect(api.setClips(["clip-b", "ghost"])).toMatchObject({
      ok: false,
      code: "clip_not_found",
    });
    expect(api.setClips(["clip-b", "clip-a::mask::m1"])).toMatchObject({
      ok: false,
      code: "clip_not_selectable",
    });
    // Nothing partially applied.
    expect(api.get().clipIds).toEqual(["clip-a"]);
  });

  it("selects a transition exclusively and clears with null", () => {
    const api = createExtensionSelectionApi(createScope());
    api.setClips(["clip-a"]);

    expect(api.setTransition("transition-1")).toEqual({
      ok: true,
      changed: true,
    });
    expect(api.get()).toEqual({ clipIds: [], transitionId: "transition-1" });
    expect(api.setTransition("transition-1")).toEqual({
      ok: true,
      changed: false,
    });

    expect(api.setTransition("ghost")).toMatchObject({
      ok: false,
      code: "transition_not_found",
    });
    expect(api.get().transitionId).toBe("transition-1");

    expect(api.setTransition(null)).toEqual({ ok: true, changed: true });
    expect(api.get()).toEqual({ clipIds: [], transitionId: null });
  });

  it("throws for malformed input", () => {
    const api = createExtensionSelectionApi(createScope());
    expect(() => api.setClips("clip-a" as unknown as string[])).toThrow(
      TypeError,
    );
    expect(() => api.setClips([""] as string[])).toThrow(TypeError);
    expect(() => api.setTransition(42 as unknown as string)).toThrow(TypeError);
  });

  it("signals subscribers once per real change", () => {
    const api = createExtensionSelectionApi(createScope());
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);

    api.setClips(["clip-a"]);
    expect(listener).toHaveBeenCalledTimes(1);
    api.setClips(["clip-a"]);
    expect(listener).toHaveBeenCalledTimes(1);
    api.setTransition("transition-1");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
