import { TexturePool } from "pixi.js";

export type FilterIntermediateFormat = "rgba8unorm" | "rgba16float";

export interface FilterPrecisionCapability {
  readonly supported: boolean;
  readonly backend: "webgl" | "webgpu" | "unknown";
  readonly reason: string;
}

interface RendererProbe {
  gl?: { getExtension(name: string): unknown };
  gpu?: unknown;
  device?: unknown;
}

let activeFormat: FilterIntermediateFormat = "rgba8unorm";

export function detectFloatFilterRenderability(
  renderer: RendererProbe,
): FilterPrecisionCapability {
  if (renderer.gpu || renderer.device) {
    return {
      supported: true,
      backend: "webgpu",
      reason: "WebGPU supports rgba16float render attachments",
    };
  }
  if (renderer.gl) {
    const supported = Boolean(
      renderer.gl.getExtension("EXT_color_buffer_float") ||
        renderer.gl.getExtension("EXT_color_buffer_half_float"),
    );
    return {
      supported,
      backend: "webgl",
      reason: supported
        ? "Floating-point color-buffer extension available"
        : "Floating-point color-buffer extension unavailable",
    };
  }
  return {
    supported: false,
    backend: "unknown",
    reason: "Renderer backend could not be probed",
  };
}

export function configureFilterIntermediatePrecision(
  renderer: RendererProbe,
): FilterPrecisionCapability {
  const capability = detectFloatFilterRenderability(renderer);
  const format: FilterIntermediateFormat = capability.supported
    ? "rgba16float"
    : "rgba8unorm";
  if (format !== activeFormat) {
    TexturePool.clear(true);
    TexturePool.textureOptions = {
      ...TexturePool.textureOptions,
      format,
    };
    activeFormat = format;
  }
  return capability;
}

export function getFilterIntermediateFormat(): FilterIntermediateFormat {
  return activeFormat;
}
