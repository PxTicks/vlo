import { describe, expect, it } from "vitest";

import { MIGRATED_WORKFLOW_IDS } from "../migratedWorkflows";

describe("MIGRATED_WORKFLOW_IDS", () => {
  it("includes the frontend-rule migrated LTX workflows", () => {
    expect(MIGRATED_WORKFLOW_IDS.has("video_ltx2_3_i2v_t2v_basic.json")).toBe(
      true,
    );
    expect(MIGRATED_WORKFLOW_IDS.has("video_ltx2_3_retake.json")).toBe(true);
  });
});
