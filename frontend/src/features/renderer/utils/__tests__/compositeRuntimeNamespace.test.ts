import { describe, expect, it } from "vitest";
import type {
  CompositeContent,
  TimelineClip,
} from "../../../../types/TimelineTypes";
import { namespaceCompositeRuntimeContent } from "../compositeRuntimeNamespace";

function content(): CompositeContent {
  const parent = {
    id: "parent",
    trackId: "track",
    type: "video",
    assetId: "asset",
    components: [
      {
        id: "mask-ref",
        type: "mask_ref",
        parameters: { maskClipId: "parent::mask::one" },
      },
    ],
    transformations: [],
  } as unknown as TimelineClip;
  const mask = {
    id: "parent::mask::one",
    parentClipId: "parent",
    trackId: "track",
    type: "mask",
    transformations: [],
  } as unknown as TimelineClip;
  return {
    durationTicks: 100,
    tracks: [
      {
        id: "track",
        label: "Track",
        isVisible: true,
        isMuted: false,
        isLocked: false,
      },
    ],
    clips: [parent, mask],
    transitions: [
      {
        id: "transition",
        type: "dissolve",
        outgoingClipId: "parent",
        incomingClipId: "parent",
        parameters: {},
      },
    ],
  };
}

describe("namespaceCompositeRuntimeContent", () => {
  it("namespaces every scene-owned identity without mutating authored content", () => {
    const authored = content();
    const runtime = namespaceCompositeRuntimeContent(authored, "placement-a");

    expect(runtime.tracks[0]).toMatchObject({
      id: "placement-a::composite::track",
      type: "visual",
    });
    expect(runtime.clips[0]).toMatchObject({
      id: "placement-a::composite::parent",
      trackId: "placement-a::composite::track",
      assetId: "asset",
      components: [
        {
          id: "placement-a::composite::mask-ref",
          parameters: {
            maskClipId: "placement-a::composite::parent::mask::one",
          },
        },
      ],
    });
    expect(runtime.clips[1]).toMatchObject({
      id: "placement-a::composite::parent::mask::one",
      parentClipId: "placement-a::composite::parent",
    });
    expect(runtime.transitions[0]).toMatchObject({
      id: "placement-a::composite::transition",
      outgoingClipId: "placement-a::composite::parent",
      incomingClipId: "placement-a::composite::parent",
    });
    expect(authored.clips[0].id).toBe("parent");
    expect(authored.tracks?.[0].id).toBe("track");
  });

  it("keeps sibling placement namespaces disjoint", () => {
    const authored = content();
    const first = namespaceCompositeRuntimeContent(authored, "placement-a");
    const second = namespaceCompositeRuntimeContent(authored, "placement-b");

    expect(first.clips[0].id).not.toBe(second.clips[0].id);
    expect(first.tracks[0].id).not.toBe(second.tracks[0].id);
    expect(first.transitions[0].id).not.toBe(second.transitions[0].id);
  });
});
