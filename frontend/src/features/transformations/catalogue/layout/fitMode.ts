import type {
  TransformHandler,
  TransformationDefinition,
} from "../types";
import type { ClipTransform } from "../../../../types/TimelineTypes";

/**
 * FitMode is a layout convenience that picks the "contain" or "cover" base
 * fit for a clip's content within the project's logical viewport. It's read
 * directly off `clip.transformations` in `applyClipTransforms` (to seed the
 * base layout before per-clip position/scale/rotation apply), not via a
 * runtime state mutation — so this handler is intentionally a no-op.
 *
 * Split from `layoutDefinition` so it can be hidden from the adjustment-
 * clip inspector (adjustments are textureless group containers; "contain"
 * vs "cover" is meaningless for them) while position/scale/rotation stay
 * available. `layoutDefinition.adjustmentCompatible` is `true`; this
 * definition's is the default `false`.
 */
const fitModeHandler: TransformHandler<ClipTransform> = () => {
  // Read directly off clip.transformations by applyClipTransforms; no
  // runtime state to mutate here.
};

export const fitModeDefinition: TransformationDefinition = {
  type: "fitMode",
  label: "Fit Mode",
  compatibleClips: "visual",
  handler: fitModeHandler,
  uiConfig: {
    groups: [
      {
        id: "fitMode",
        title: "FIT MODE",
        columns: 1,
        controls: [
          {
            type: "select",
            label: "Fit",
            name: "fitMode",
            defaultValue: "contain",
            options: [
              { label: "Contain (Letterbox)", value: "contain" },
              { label: "Cover (Fill)", value: "cover" },
            ],
          },
        ],
      },
    ],
  },
};
