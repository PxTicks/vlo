import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionTimelineTransaction,
  ExtensionTimelineTransactionOptions,
  VloExtensionApi,
} from "../../types";
import {
  commitPaintedResult,
  splitStrokePoints,
} from "../../../../../../extension-fixtures/painting/frontend/src/index";
import { createExtensionTimelineTransactionStub } from "../../../../testUtils/extensionTimeline";

describe("painting extension conformance fixture", () => {
  it("splits long interactions into endpoint-overlapping coalescible commits", () => {
    const points = Array.from({ length: 130 }, (_, index) => ({
      x: index,
      y: index,
    }));

    const chunks = splitStrokePoints(points, 64);

    expect(chunks.map((chunk) => chunk.length)).toEqual([64, 64, 4]);
    expect(chunks[0]?.at(-1)).toEqual(chunks[1]?.at(0));
    expect(chunks[1]?.at(-1)).toEqual(chunks[2]?.at(0));
  });

  it("commits each painted result as both a bitmap mask and entity payload", () => {
    const addClipMask = vi.fn(() => "mask-1");
    const createEntity = vi.fn(() => "entity-1");
    const transaction = vi.fn(
      (
        label: string,
        callback: (draft: ExtensionTimelineTransaction) => void,
        options?: ExtensionTimelineTransactionOptions,
      ) => {
        callback(
          createExtensionTimelineTransactionStub({
            addClipMask,
            createEntity,
          }),
        );
        return { ok: true as const, changed: true, label, options };
      },
    );
    const api = {
      timeline: {
        listClips: () => [
          {
            id: "clip-1",
            trackId: "track-1",
            startTicks: 100,
            durationTicks: 500,
          },
        ],
        getProject: () => ({
          width: 1920,
          height: 1080,
          fps: 30,
          fitMode: "cover" as const,
        }),
        transaction,
      },
    } as unknown as VloExtensionApi;
    const points = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ];
    const preset = { radius: 5, color: "#ff3366", opacity: 0.8 };

    const result = commitPaintedResult(
      api,
      "clip-1",
      "asset-1",
      points,
      preset,
      "stroke-1",
      true,
    );

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(transaction).toHaveBeenCalledWith(
      "Paint stroke",
      expect.any(Function),
      { coalesce: { key: "stroke-1", phase: "end" } },
    );
    expect(addClipMask).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        maskType: "brush",
        assetId: "asset-1",
        parameters: { baseWidth: 1920, baseHeight: 1080 },
        paintedBounds: { x: 5, y: 15, width: 30, height: 30 },
      }),
    );
    expect(createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        trackId: "track-1",
        startTicks: 100,
        durationTicks: 500,
        payload: expect.objectContaining({
          extensionId: "example.painting",
          typeId: "stroke",
          data: expect.objectContaining({ assetId: "asset-1", points }),
        }),
      }),
    );
  });
});
