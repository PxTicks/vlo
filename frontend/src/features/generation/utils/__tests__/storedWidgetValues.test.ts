import { describe, expect, it } from "vitest";

import { parseStoredWidgetValue } from "../storedWidgetValues";
import type { WorkflowWidgetInput } from "../../types";

function makeWidget(
  overrides: Partial<WorkflowWidgetInput> = {},
): WorkflowWidgetInput {
  return {
    kind: "raw",
    nodeId: "145",
    param: "seed",
    currentValue: 0,
    config: {
      label: "Seed",
      controlAfterGenerate: true,
      valueType: "int",
    },
    ...overrides,
  } as WorkflowWidgetInput;
}

describe("storedWidgetValues", () => {
  it("preserves unsafe integer seeds as strings", () => {
    expect(
      parseStoredWidgetValue(
        makeWidget(),
        "18446744073709551615",
      ),
    ).toBe("18446744073709551615");
  });

  it("parses safe integer seeds back to numbers", () => {
    expect(parseStoredWidgetValue(makeWidget(), "42")).toBe(42);
  });

  it("maps boolean workflow values back to booleans", () => {
    expect(
      parseStoredWidgetValue(
        makeWidget({
          currentValue: false,
          config: {
            label: "Enabled",
            controlAfterGenerate: false,
            valueType: "boolean",
            trueValue: "enabled",
            falseValue: "disabled",
          },
        }),
        "enabled",
      ),
    ).toBe(true);
  });
});
