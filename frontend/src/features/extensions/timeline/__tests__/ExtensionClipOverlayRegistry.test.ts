import { describe, it, expect, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionClipOverlayItem,
} from "../..";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import { extensionClipOverlayRegistry } from "../ExtensionClipOverlayRegistry";

function makeScope(id: string): ExtensionApiScope {
  return {
    extension: { id, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

const FAKE_CLIP = {
  id: "clip-1",
  type: "video",
  name: "Clip",
  trackId: "track-1",
  start: 0,
  timelineDuration: 100,
  transformations: [],
} as unknown as TimelineClip;

function overlayFor(contributionId: string) {
  const entry = extensionClipOverlayRegistry
    .list()
    .find((candidate) => candidate.id === contributionId);
  if (!entry) throw new Error(`Overlay '${contributionId}' was not registered.`);
  return entry.definition.overlay;
}

describe("ExtensionClipOverlayRegistry", () => {
  it("adapts items, passes a detached clip snapshot, and isolates handlers", () => {
    const scope = makeScope("example.overlay");
    const useItems = vi.fn(
      (): readonly ExtensionClipOverlayItem[] => [
        {
          id: "badge",
          content: "!",
          placement: {
            kind: "endpoint",
            edge: "end",
            lane: "top",
            insetPx: 4,
            order: 0,
          },
          onClick: () => {
            throw new Error("click boom");
          },
        },
      ],
    );
    const registration = extensionClipOverlayRegistry.bind(scope).register({
      id: "marker",
      apiVersion: 1,
      kind: "trusted-overlay",
      useItems,
    });

    try {
      const overlay = overlayFor("example.overlay/marker");
      const items = overlay.useItems({ clip: FAKE_CLIP, isSelected: true });

      // The extension receives a detached snapshot (durationTicks, not the
      // internal timelineDuration), never the raw mutable clip.
      expect(useItems).toHaveBeenCalledWith({
        clip: expect.objectContaining({
          id: "clip-1",
          type: "video",
          durationTicks: 100,
        }),
        isSelected: true,
      });
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("badge");
      expect(items[0].visibility).toBe("always");

      // A throwing handler is contained and reported, not propagated.
      items[0].onClick?.();
      expect(scope.report).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("example.overlay/marker"),
        expect.any(Error),
      );
    } finally {
      registration.dispose();
    }

    expect(
      extensionClipOverlayRegistry
        .list()
        .some((entry) => entry.id === "example.overlay/marker"),
    ).toBe(false);
  });

  it("drops items and reports when useItems throws", () => {
    const scope = makeScope("example.overlay-throw");
    const registration = extensionClipOverlayRegistry.bind(scope).register({
      id: "broken",
      apiVersion: 1,
      kind: "trusted-overlay",
      useItems: () => {
        throw new Error("items boom");
      },
    });

    try {
      const overlay = overlayFor("example.overlay-throw/broken");
      expect(overlay.useItems({ clip: FAKE_CLIP, isSelected: false })).toEqual(
        [],
      );
      expect(scope.report).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("useItems"),
        expect.any(Error),
      );
    } finally {
      registration.dispose();
    }
  });

  it("rejects definitions that are not trusted-overlay API 1", () => {
    const bound = extensionClipOverlayRegistry.bind(makeScope("example.bad"));
    expect(() =>
      bound.register({
        id: "wrong",
        apiVersion: 2 as 1,
        kind: "trusted-overlay",
        useItems: () => [],
      }),
    ).toThrow(/trusted-overlay API 1/);
  });
});
