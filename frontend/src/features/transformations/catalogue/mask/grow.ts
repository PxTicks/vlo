import type {
  TransformationDefinition,
  TransformState,
  TransformContext,
} from "../types";
import { isSplineParameter } from "../../utils/typeGuards";
import { resolveScalar } from "../../utils/resolveScalar";

export const maskGrowDefinition: TransformationDefinition = {
  type: "mask_grow",
  label: "Grow Mask",
  compatibleClips: "mask",
  handler: (state: TransformState, transform, context: TransformContext) => {
    let amount = 0;
    const amountParam = transform.parameters.amount;

    if (typeof amountParam === "number") {
      amount = amountParam;
    } else if (isSplineParameter(amountParam)) {
      amount = resolveScalar(amountParam, context.time ?? 0, 0);
    }

    state.maskGrow = { amount };
  },
  uiConfig: {
    groups: [
      {
        id: "mask_grow",
        title: "Grow Mask",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Amount",
            name: "amount",
            defaultValue: 0,
            min: 0,
            max: 100,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
