import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../../extensions/ExtensionHost";
import { createVloExtensionApi } from "../../../extensions/services/FrontendExtensionRuntime";
import type {
  ExtensionKeyframedScalarParameter,
  ExtensionModule,
  ExtensionPayload,
  JsonValue,
  VloExtensionApi,
} from "../../../extensions/types";
import { extensionInterpolationRegistry } from "../ExtensionAnimationRegistry";
import { MonotoneCubicSpline } from "../../utils/MonotoneCubicSpline";
import { resolveScalar } from "../../utils/resolveScalar";
import { reflectScalarParameterTime } from "../../utils/reverseSpline";

const EXTENSION_ID = "vlo.bezier-curves";

// The Bezier Curves extension is an optional package with its own repository,
// installed into the git-ignored extension root. When present it doubles as
// the conformance fixture for the animation.interpolations seam; on checkouts
// without it this suite skips rather than failing. The static import of the
// package lives in bezierCurvesPackageLoader.ts, which is only dynamically
// loaded after the existence check, so nothing resolves eagerly when the
// package is absent.
const PACKAGE_ENTRY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
  "extensions",
  EXTENSION_ID,
  "frontend/src/index.ts",
);
const packagePresent = existsSync(PACKAGE_ENTRY_PATH);

async function loadActivate(): Promise<ExtensionModule["activate"]> {
  return (await import("./bezierCurvesPackageLoader")).bezierCurvesActivate;
}

function bezierPayload(data: JsonValue): ExtensionPayload {
  return {
    extensionId: EXTENSION_ID,
    typeId: "bezier",
    schemaVersion: 1,
    data,
  };
}

function keyframedParameter(
  points: readonly { time: number; value: number }[],
  segmentData: readonly JsonValue[],
): ExtensionKeyframedScalarParameter {
  return {
    type: "extension-keyframed-scalar",
    keyframes: points.map((point, index) => ({
      ...point,
      outgoing:
        index < points.length - 1 ? bezierPayload(segmentData[index]) : undefined,
    })),
  };
}

const AUTO: JsonValue = { version: 1, out: null, in: null };

async function activateFixture(): Promise<ExtensionHost<VloExtensionApi>> {
  const host = new ExtensionHost<VloExtensionApi>({
    sdkVersion: "1.0.0",
    createApi: createVloExtensionApi,
  });
  await host.activate(
    { id: EXTENSION_ID, version: "1.0.0" },
    { activate: await loadActivate() },
  );
  return host;
}

let activeHost: ExtensionHost<VloExtensionApi> | undefined;

afterEach(async () => {
  if (activeHost) {
    await activeHost.deactivate(EXTENSION_ID);
    activeHost = undefined;
  }
});

describe.skipIf(!packagePresent)("bezier curves conformance fixture", () => {
  it("reproduces the core monotone Hermite spline exactly with auto handles", async () => {
    activeHost = await activateFixture();

    const points = [
      { time: 0, value: 0.2 },
      { time: 1_000, value: 1.4 },
      { time: 2_500, value: 0.6 },
      { time: 3_200, value: 0.6 },
      { time: 4_000, value: 1.9 },
    ];
    const parameter = keyframedParameter(points, [AUTO, AUTO, AUTO, AUTO]);
    const hermite = new MonotoneCubicSpline(points);

    for (let step = 0; step <= 400; step += 1) {
      const time = (4_000 * step) / 400;
      expect(resolveScalar(parameter, time, Number.NaN)).toBeCloseTo(
        hermite.at(time),
        6,
      );
    }
  });

  it("interpolates endpoints and allows overshoot with explicit handles", async () => {
    activeHost = await activateFixture();

    const overshoot = keyframedParameter(
      [
        { time: 0, value: 0 },
        { time: 100, value: 1 },
      ],
      [{ version: 1, out: { u: 0, dv: 2 }, in: { u: 1, dv: 2 } }],
    );
    expect(resolveScalar(overshoot, 0, Number.NaN)).toBeCloseTo(0, 9);
    expect(resolveScalar(overshoot, 100, Number.NaN)).toBeCloseTo(1, 9);
    expect(resolveScalar(overshoot, 50, Number.NaN)).toBeGreaterThan(1);

    // Extreme time handles (u1=1, u2=0) stay a single-valued, monotone ease.
    const ease = keyframedParameter(
      [
        { time: 0, value: 0 },
        { time: 100, value: 1 },
      ],
      [{ version: 1, out: { u: 1, dv: 0 }, in: { u: 0, dv: 0 } }],
    );
    let previous = Number.NEGATIVE_INFINITY;
    for (let step = 0; step <= 200; step += 1) {
      const value = resolveScalar(ease, (100 * step) / 200, Number.NaN);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
    expect(resolveScalar(ease, 50, Number.NaN)).toBeCloseTo(0.5, 6);
  });

  it("exposes a derivative consistent with finite differences", async () => {
    activeHost = await activateFixture();

    const payload = bezierPayload({
      version: 1,
      out: { u: 0.4, dv: 0.9 },
      in: { u: 0.7, dv: -0.3 },
    });
    const keyframes = [
      { time: 0, value: 0, outgoing: payload },
      { time: 200, value: 1 },
    ];
    const compiled = extensionInterpolationRegistry.compile(payload, keyframes, 0);
    for (const time of [20, 60, 100, 140, 180]) {
      const epsilon = 0.01;
      const numeric =
        (compiled.sample(time + epsilon) - compiled.sample(time - epsilon)) /
        (2 * epsilon);
      expect(compiled.derivative?.(time)).toBeCloseTo(numeric, 3);
    }
    compiled.dispose();
  });

  it("supports host reversal through remap", async () => {
    activeHost = await activateFixture();

    const parameter = keyframedParameter(
      [
        { time: 0, value: 0 },
        { time: 60, value: 1.5 },
        { time: 100, value: 0.25 },
      ],
      [
        { version: 1, out: { u: 0.1, dv: 1.2 }, in: { u: 0.9, dv: 0.4 } },
        AUTO,
      ],
    );
    const reflected = reflectScalarParameterTime(parameter, 50);
    expect(reflected).toBeDefined();
    for (let step = 0; step <= 200; step += 1) {
      const time = (100 * step) / 200;
      expect(resolveScalar(reflected, time, Number.NaN)).toBeCloseTo(
        resolveScalar(parameter, 100 - time, Number.NaN),
        6,
      );
    }
  });

  it("rejects malformed segment data", async () => {
    activeHost = await activateFixture();

    const keyframes = [
      { time: 0, value: 0 },
      { time: 100, value: 1 },
    ];
    const invalid = [
      "not-an-object",
      { version: 2, out: null, in: null },
      { version: 1, out: { u: 2, dv: 0 }, in: null },
      { version: 1, out: { u: 0.5, dv: Number.NaN }, in: null },
    ];
    for (const data of invalid) {
      expect(() =>
        extensionInterpolationRegistry.compile(
          bezierPayload(data as JsonValue),
          keyframes,
          0,
        ),
      ).toThrow();
    }
  });

  it("rolls back the registration and fails closed after deactivation", async () => {
    const host = await activateFixture();
    const parameter = keyframedParameter(
      [
        { time: 0, value: 0 },
        { time: 100, value: 1 },
      ],
      [AUTO],
    );
    expect(extensionInterpolationRegistry.get(bezierPayload(AUTO))).toBeDefined();
    expect(resolveScalar(parameter, 50, -1)).not.toBe(-1);

    await host.deactivate(EXTENSION_ID);
    expect(extensionInterpolationRegistry.get(bezierPayload(AUTO))).toBeUndefined();
    expect(resolveScalar(parameter, 50, -1)).toBe(-1);
  });
});
