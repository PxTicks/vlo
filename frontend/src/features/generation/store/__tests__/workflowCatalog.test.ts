import { describe, expect, it } from "vitest";
import { TEMP_WORKFLOW_ID } from "../constants";
import {
  resolveWorkflowPersistenceId,
  upsertTempWorkflowOption,
} from "../workflowCatalog";

describe("workflowCatalog", () => {
  it("prefers the selected workflow id for temporary duplicate filenames", () => {
    expect(resolveWorkflowPersistenceId("wf.json", "wf (1).json")).toBe(
      "wf.json",
    );
  });

  it("adds a temp workflow option with the stable temp id", () => {
    const workflows = upsertTempWorkflowOption([], {
      workflow: {},
      graphData: {},
      inputs: [],
    });

    expect(workflows).toEqual([
      {
        id: TEMP_WORKFLOW_ID,
        name: "Edited Workflow",
      },
    ]);
  });
});
