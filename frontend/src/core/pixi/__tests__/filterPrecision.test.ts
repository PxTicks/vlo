import { afterEach, describe, expect, it } from "vitest";
import { TexturePool } from "pixi.js";
import {
  configureFilterIntermediatePrecision,
  detectFloatFilterRenderability,
  getFilterIntermediateFormat,
} from "../filterPrecision";

describe("filter intermediate precision", () => {
  afterEach(() => {
    configureFilterIntermediatePrecision({
      gl: { getExtension: () => null },
    });
  });

  it("selects rgba16float when WebGL exposes a renderable float buffer", () => {
    const capability = configureFilterIntermediatePrecision({
      gl: {
        getExtension: (name) =>
          name === "EXT_color_buffer_float" ? {} : null,
      },
    });
    expect(capability.supported).toBe(true);
    expect(getFilterIntermediateFormat()).toBe("rgba16float");
    expect(TexturePool.textureOptions.format).toBe("rgba16float");
  });

  it("uses the tested 8-bit fallback without float renderability", () => {
    const capability = detectFloatFilterRenderability({
      gl: { getExtension: () => null },
    });
    expect(capability.supported).toBe(false);
    configureFilterIntermediatePrecision({ gl: { getExtension: () => null } });
    expect(getFilterIntermediateFormat()).toBe("rgba8unorm");
  });
});
