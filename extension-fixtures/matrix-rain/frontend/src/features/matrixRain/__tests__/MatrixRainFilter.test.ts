import { describe, expect, it } from "vitest";
import type {
  ExtensionPixiFilterOptions,
  ExtensionPixiRuntime,
} from "@vlo/extension-sdk";
import { createMatrixRainFilter } from "../MatrixRainFilter";
import { DEFAULT_MATRIX_RAIN_PARAMETERS } from "../constants";

interface UniformStructure {
  readonly value: number | Float32Array;
}

type LiveUniforms = Record<string, number | Float32Array>;

function createPixiRuntime() {
  let liveUniforms: LiveUniforms | undefined;
  const runtime = {
    Filter: {
      from(options: ExtensionPixiFilterOptions) {
        const structures = options.resources?.matrixRainUniforms as Record<
          string,
          UniformStructure
        >;
        liveUniforms = Object.fromEntries(
          Object.entries(structures).map(([name, structure]) => [
            name,
            structure.value,
          ]),
        );
        return {
          resources: {
            matrixRainUniforms: { uniforms: liveUniforms },
          },
        };
      },
    },
  } as unknown as ExtensionPixiRuntime;

  return {
    runtime,
    getLiveUniforms() {
      if (!liveUniforms) throw new Error("Filter.from was not called");
      return liveUniforms;
    },
  };
}

describe("createMatrixRainFilter", () => {
  it("updates Pixi's live scalar uniforms, output mode, time, and content size", () => {
    const pixi = createPixiRuntime();
    const instance = createMatrixRainFilter(pixi.runtime, 96_000);

    instance.update(
      {
        ...DEFAULT_MATRIX_RAIN_PARAMETERS,
        size: 24,
        seed: 77,
        fallSpeed: 13,
        outputMode: "matrixOnly",
        debugMode: "proceduralHead",
      },
      {
        target: {},
        transformId: "matrix-1",
        contentSize: { width: 1920, height: 1080 },
        render: {
          sequenceId: 1,
          sampleId: 2,
          mode: "preview",
          continuity: "sequential",
          presentationTimeTicks: 48_000,
          visualTimeTicks: 48_000,
          sourceTimeTicks: 48_000,
          deltaTimeTicks: 3_200,
          fps: 30,
          isWarmup: false,
        },
      },
    );

    const uniforms = pixi.getLiveUniforms();
    expect(uniforms.uTimeSeconds).toBe(0.5);
    expect(uniforms.uSize).toBe(24);
    expect(uniforms.uSeed).toBe(77);
    expect(uniforms.uFallSpeed).toBe(13);
    expect(uniforms.uOutputMode).toBe(1);
    expect(uniforms.uDebugMode).toBe(3);
    expect(Array.from(uniforms.uContentSize as Float32Array)).toEqual([
      1920, 1080,
    ]);
  });
});
