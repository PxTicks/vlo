import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFORMATION_RENDERING_POLICY,
  normalizeTransformationRenderingPolicy,
} from "../renderingPolicy";

describe("native transformation rendering policy", () => {
  it("defaults an omitted policy to frozen stateless behavior", () => {
    const policy = normalizeTransformationRenderingPolicy(
      undefined,
      "NativeFilter",
    );

    expect(policy).toBe(DEFAULT_TRANSFORMATION_RENDERING_POLICY);
    expect(policy).toEqual({
      timeDependency: "none",
      maxHistorySeconds: 0,
      maxStepSeconds: null,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("normalizes and freezes a native history policy", () => {
    const policy = normalizeTransformationRenderingPolicy(
      {
        timeDependency: "history",
        maxHistorySeconds: 4,
        maxStepSeconds: 1 / 30,
      },
      "NativeHistoryFilter",
    );

    expect(policy).toEqual({
      timeDependency: "history",
      maxHistorySeconds: 4,
      maxStepSeconds: 1 / 30,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("applies host bounds before any extension projection", () => {
    expect(() =>
      normalizeTransformationRenderingPolicy(
        { timeDependency: "history", maxHistorySeconds: 31 },
        "NativeHistoryFilter",
      ),
    ).toThrow("maxHistorySeconds");
    expect(() =>
      normalizeTransformationRenderingPolicy(
        { timeDependency: "sample", maxHistorySeconds: 1 },
        "NativeSampleFilter",
      ),
    ).toThrow("only for a history filter");
  });
});
