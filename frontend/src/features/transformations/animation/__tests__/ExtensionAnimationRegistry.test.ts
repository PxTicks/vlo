import { afterEach, describe, expect, it } from "vitest";
import { Container } from "pixi.js";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionSpatialPathParameter,
} from "../../../extensions/types";
import {
  createExtensionAnimationApi,
  extensionInterpolationRegistry,
  extensionScalarSourceRegistry,
  extensionSpatialPathRegistry,
} from "../ExtensionAnimationRegistry";
import { resolveScalar } from "../../utils/resolveScalar";
import { samplePositionPath } from "../../utils/positionPath";
import { getIdempotentTimeMap } from "../../utils/timeCalculation";
import { reflectScalarParameterTime, reversePositionPath } from "../../utils/reverseSpline";
import { TrustedSpatialPathOverlayRenderer } from "../TrustedSpatialPathOverlayRenderer";

const owned: ExtensionResource[] = [];

function createScope(extensionId: string): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: (resource) => {
      owned.push(resource);
      return resource;
    },
    report: () => undefined,
  };
}

afterEach(async () => {
  while (owned.length > 0) {
    const resource = owned.pop();
    if (typeof resource === "function") await resource();
    else await resource?.dispose();
  }
});

describe("extension animation architecture", () => {
  it("compiles an opaque procedural scalar and uses its explicit speed map", () => {
    const api = createExtensionAnimationApi(createScope("test.scalar-source"));
    let disposed = 0;
    const registration = api.scalarSources.register({
      id: "offset-clock",
      apiVersion: 1,
      label: "Offset clock",
      schemaVersion: 1,
      defaultData: 0,
      validate: (data) => {
        if (typeof data !== "number") throw new Error("Expected an offset.");
      },
      compile: (data) => ({
        sample: (time) => time + (data as number),
        timeMap: {
          outputToInput: (time) => time * 2,
          inputToOutput: (time) => time / 2,
        },
        dispose: () => {
          disposed += 1;
        },
      }),
      remap: (data, schemaVersion) => ({ schemaVersion, data }),
    });

    const value = {
      type: "extension-scalar" as const,
      source: {
        extensionId: "test.scalar-source",
        typeId: "offset-clock",
        schemaVersion: 1,
        data: 3,
      },
    };
    expect(resolveScalar(value, 7)).toBe(10);
    expect(getIdempotentTimeMap(value, 5)).toBe(10);
    expect(extensionScalarSourceRegistry.get(value.source)?.ownerId).toBe(
      "test.scalar-source",
    );
    registration.dispose();
    expect(disposed).toBe(1);
  });

  it("dispatches each host-owned keyframe segment through its provider", () => {
    const api = createExtensionAnimationApi(createScope("test.interpolation"));
    api.interpolations.register({
      id: "test-curve",
      apiVersion: 1,
      label: "Test curve",
      schemaVersion: 1,
      defaultData: null,
      validate: (data) => {
        if (data !== null) throw new Error("Expected null configuration.");
      },
      compile: ({ keyframes, segmentIndex }) => {
        const start = keyframes[segmentIndex];
        return {
          sample: (time) => start.value + (time - start.time) ** 2,
          dispose: () => undefined,
        };
      },
      remap: ({ data, schemaVersion }) => ({ schemaVersion, data }),
    });
    const outgoing = {
      extensionId: "test.interpolation",
      typeId: "test-curve",
      schemaVersion: 1,
      data: null,
    } as const;
    const value = {
      type: "extension-keyframed-scalar" as const,
      keyframes: [
        { time: 0, value: 2, outgoing },
        { time: 10, value: 102 },
      ],
    };

    expect(resolveScalar(value, -1)).toBe(2);
    expect(resolveScalar(value, 3)).toBe(11);
    expect(resolveScalar(value, 12)).toBe(102);
    expect(extensionInterpolationRegistry.get(outgoing)?.ownerId).toBe(
      "test.interpolation",
    );
  });

  it("keeps geometry and progress providers independent", () => {
    const api = createExtensionAnimationApi(createScope("test.spatial-path"));
    api.spatialPaths.register({
      id: "parametric",
      apiVersion: 1,
      label: "Parametric path",
      schemaVersion: 1,
      defaultData: 1,
      validate: (data) => {
        if (typeof data !== "number") throw new Error("Expected scale.");
      },
      compile: (data) => ({
        pointAt: (progress) => ({
          x: progress * (data as number),
          y: progress * progress,
        }),
        dispose: () => undefined,
      }),
      reverse: (data, schemaVersion) => ({ schemaVersion, data }),
    });
    const path: ExtensionSpatialPathParameter = {
      type: "extension-path2d",
      geometry: {
        extensionId: "test.spatial-path",
        typeId: "parametric",
        schemaVersion: 1,
        data: 20,
      },
      timing: 0.25,
    };

    expect(samplePositionPath(path, 50, 100)).toEqual({ x: 5, y: 0.0625 });
    expect(extensionSpatialPathRegistry.get(path.geometry)?.ownerId).toBe(
      "test.spatial-path",
    );
    const reversed = reversePositionPath(path);
    expect(reversed.geometry.data).toBe(20);
    expect(reversed.timing).toBe(0.75);
  });

  it("fails reversal when opaque source data has no remap capability", () => {
    const api = createExtensionAnimationApi(createScope("test.no-remap"));
    api.scalarSources.register({
      id: "read-only",
      apiVersion: 1,
      label: "Read only",
      schemaVersion: 1,
      defaultData: null,
      validate: () => undefined,
      compile: () => ({
        sample: () => 1,
        dispose: () => undefined,
      }),
    });

    expect(() =>
      reflectScalarParameterTime(
        {
          type: "extension-scalar",
          source: {
            extensionId: "test.no-remap",
            typeId: "read-only",
            schemaVersion: 1,
            data: null,
          },
        },
        10,
      ),
    ).toThrow("does not support reversal or retiming");
  });

  it("mounts trusted path overlays through the shared host-object lifecycle", () => {
    const api = createExtensionAnimationApi(createScope("test.path-overlay"));
    const object = new Container();
    let updates = 0;
    let extensionDestroyed = false;
    api.spatialPaths.register({
      id: "overlay-path",
      apiVersion: 1,
      label: "Overlay path",
      schemaVersion: 1,
      defaultData: null,
      validate: () => undefined,
      compile: () => ({
        pointAt: () => ({ x: 0, y: 0 }),
        dispose: () => undefined,
      }),
      createOverlay: () => ({
        object,
        update: () => {
          updates += 1;
        },
        destroy: () => {
          extensionDestroyed = true;
        },
      }),
    });
    const renderer = new TrustedSpatialPathOverlayRenderer();
    const slot = new Container();
    const path: ExtensionSpatialPathParameter = {
      type: "extension-path2d",
      geometry: {
        extensionId: "test.path-overlay",
        typeId: "overlay-path",
        schemaVersion: 1,
        data: null,
      },
      timing: 0,
    };

    expect(
      renderer.update(path, 10, 100, slot, {
        viewport: {
          width: 640,
          height: 360,
          projectWidth: 1920,
          projectHeight: 1080,
        },
      }),
    ).toBe(true);
    expect(object.parent).toBe(slot);
    expect(updates).toBe(1);

    renderer.dispose();
    expect(object.destroyed).toBe(true);
    expect(extensionDestroyed).toBe(true);
  });

  it("publishes a defensive deep-frozen copy of provider defaults", () => {
    const api = createExtensionAnimationApi(createScope("test.defaults"));
    const defaultData = { nested: { radius: 12 } };
    api.spatialPaths.register({
      id: "immutable-default",
      apiVersion: 1,
      label: "Immutable default",
      schemaVersion: 1,
      defaultData,
      validate: () => undefined,
      compile: () => ({
        pointAt: () => ({ x: 0, y: 0 }),
        dispose: () => undefined,
      }),
    });
    defaultData.nested.radius = 99;

    const published = extensionSpatialPathRegistry.list().find(
      ({ id }) => id === "test.defaults/immutable-default",
    )?.definition.defaultData;
    expect(published).toEqual({ nested: { radius: 12 } });
    expect(Object.isFrozen(published)).toBe(true);
    expect(
      typeof published === "object" && published !== null && !Array.isArray(published)
        ? Object.isFrozen(published.nested)
        : false,
    ).toBe(true);
  });
});
