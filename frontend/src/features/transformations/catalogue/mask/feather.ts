import type {
  TransformationDefinition,
  TransformState,
  TransformContext,
} from "../types";
import { isSplineParameter } from "../../utils/typeGuards";
import { resolveScalar } from "../../utils/resolveScalar";

export const featherDefinition: TransformationDefinition = {
  type: "feather",
  label: "Feather Edge",
  compatibleClips: "mask",
  handler: (state: TransformState, transform, context: TransformContext) => {
    let amount = 0;
    const amountParam = transform.parameters.amount;

    if (typeof amountParam === "number") {
      amount = amountParam;
    } else if (isSplineParameter(amountParam)) {
      amount = resolveScalar(amountParam, context.time ?? 0, 0);
    }

    const rawMode = transform.parameters.mode;
    const mode: "hard_outer" | "soft_inner" | "two_way" =
      rawMode === "soft_inner" || rawMode === "two_way"
        ? rawMode
        : "hard_outer";

    state.feather = {
      amount,
      mode,
    };
  },
  uiConfig: {
    groups: [
      {
        id: "feather",
        title: "Feather Edge",
        columns: 1,
        controls: [
          {
            type: "select",
            label: "Type",
            name: "mode",
            defaultValue: "hard_outer",
            options: [
              { label: "Hard Outer", value: "hard_outer" },
              { label: "Soft Inner", value: "soft_inner" },
              { label: "Two-way", value: "two_way" },
            ],
          },
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
