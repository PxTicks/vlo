import { describe, expect, it } from "vitest";
import type {
  ExtensionTimelineApi,
  ExtensionTimelineTransformInput,
} from "../../extensions/types";
import type { PositionPathParameter } from "../../transformations/types";
import { commitTrackingPositionPath } from "../positionPathCommit";
import { createExtensionTimelineTransactionStub } from "../../../testUtils/extensionTimeline";

const path: PositionPathParameter = {
  type: "path2d",
  curve: "centripetal_catmull_rom",
  controlPoints: [
    { x: 0, y: 0 },
    { x: -10, y: 5 },
  ],
  timing: {
    type: "spline",
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ],
  },
};

describe("commitTrackingPositionPath", () => {
  it("commits the tracked path through an extension timeline transaction", () => {
    const committedTransforms: ExtensionTimelineTransformInput[] = [];
    const timeline: Pick<ExtensionTimelineApi, "listClips" | "transaction"> = {
      listClips: () => [
        {
          id: "clip-1",
          type: "video",
          name: "Clip",
          trackId: "track-1",
          startTicks: 0,
          durationTicks: 100,
          transformations: [
            {
              id: "position-1",
              type: "position",
              isEnabled: true,
              parameters: {
                x: 12,
                y: 8,
                extensionPath: {
                  type: "extension-path2d",
                  geometry: {
                    extensionId: "example",
                    typeId: "path",
                    schemaVersion: 1,
                    data: null,
                  },
                  timing: 0,
                },
              },
            },
          ],
        },
      ],
      transaction: (label, callback) => {
        const draft = createExtensionTimelineTransactionStub({
          upsertTransform: (_clipId, transform) => {
            committedTransforms.push(transform);
            return transform.id ?? "generated";
          },
        });
        callback(draft);
        return { ok: true, changed: true, label };
      },
    };

    const result = commitTrackingPositionPath({
      timeline,
      clipId: "clip-1",
      path,
    });

    expect(result).toMatchObject({ ok: true, transformId: "position-1" });
    const committed = committedTransforms[0];
    expect(committed).toMatchObject({
      id: "position-1",
      type: "position",
      parameters: { x: 12, y: 8, path },
    });
    expect(committed?.parameters).not.toHaveProperty("extensionPath");
  });
});
