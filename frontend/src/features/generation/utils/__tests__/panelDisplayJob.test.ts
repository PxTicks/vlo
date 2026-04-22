import { describe, expect, it } from "vitest";
import type { GenerationJob } from "../../types";
import { shouldShowHistoricalGenerationJob } from "../panelDisplayJob";

function makeJob(
  status: GenerationJob["status"],
  error: string | null = null,
): Pick<GenerationJob, "status" | "error"> {
  return { status, error };
}

describe("panelDisplayJob", () => {
  it("keeps completed jobs eligible for historical panel display", () => {
    expect(shouldShowHistoricalGenerationJob(makeJob("completed"))).toBe(true);
  });

  it("keeps ordinary errors eligible for historical panel display", () => {
    expect(
      shouldShowHistoricalGenerationJob(makeJob("error", "Model failed")),
    ).toBe(true);
  });

  it("does not pin transient generation errors as historical display jobs", () => {
    expect(
      shouldShowHistoricalGenerationJob(
        makeJob("error", "Generation interrupted"),
      ),
    ).toBe(false);
    expect(
      shouldShowHistoricalGenerationJob(
        makeJob("error", "Generation cancelled by user"),
      ),
    ).toBe(false);
  });

  it("does not pin empty delivery finalization errors as historical display jobs", () => {
    expect(
      shouldShowHistoricalGenerationJob(
        makeJob(
          "error",
          "Generation completed without persisted final outputs for delivery",
        ),
      ),
    ).toBe(false);
  });
});
