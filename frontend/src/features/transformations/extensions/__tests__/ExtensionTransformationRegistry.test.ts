import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExtensionHost,
  type ExtensionApiScope,
  type ExtensionResource,
  type ExtensionTransformationApi,
} from "../../../extensions";
import {
  dispatchTransform,
  getAddableTransforms,
  getEntryByFilterName,
  getMissingExtensionTransformationId,
} from "../../catalogue/TransformationRegistry";
import { createAddTransform } from "../../hooks/controller/transformFactory";
import { applyTransformStack } from "../../applyTransformations";
import { filterApplicator } from "../../catalogue/filterFactory";
import type { GenericFilterTransform } from "../../types";
import type { ClipTransformTarget } from "../../catalogue/types";
import { Filter } from "pixi.js";
import { createVloExtensionApi } from "../../../extensions/services/FrontendExtensionRuntime";
import {
  ExtensionTransformationRegistry,
  extensionTransformationRegistry,
} from "../ExtensionTransformationRegistry";

const disposers: Array<() => void> = [];

function createScope(
  extensionId: string,
  report = vi.fn(),
): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

function registerColorGrade(
  registry: ExtensionTransformationRegistry,
  extensionId = "example.color-grade",
) {
  return registry.bind(createScope(extensionId)).register({
    id: "film-grade",
    apiVersion: 1,
    kind: "host-filter",
    hostFilter: "color-adjustment",
    label: "Film Grade",
    adjustmentCompatible: true,
    groups: [
      {
        id: "grade",
        title: "Grade",
        controls: [
          {
            type: "slider",
            name: "gamma",
            label: "Gamma",
            defaultValue: 1,
            min: 0,
            max: 5,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            name: "saturation",
            label: "Saturation",
            defaultValue: 1,
            min: 0,
            max: 5,
            step: 0.1,
            supportsSpline: true,
          },
        ],
      },
    ],
  });
}

describe("ExtensionTransformationRegistry", () => {
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("registers a namespaced filter used by UI creation and live/export dispatch", () => {
    const registration = registerColorGrade(extensionTransformationRegistry);
    disposers.push(() => registration.dispose());

    const entry = getEntryByFilterName("example.color-grade/film-grade");
    expect(entry).toMatchObject({
      label: "Film Grade",
      filterName: "example.color-grade/film-grade",
      adjustmentCompatible: true,
      extension: { ownerId: "example.color-grade" },
    });
    expect(
      getAddableTransforms({ clipType: "video" }).map(
        (definition) => definition.filterName,
      ),
    ).toContain("example.color-grade/film-grade");

    const transform = createAddTransform(
      "example.color-grade/film-grade",
      true,
    );
    expect(transform).toMatchObject({
      type: "filter",
      filterName: "example.color-grade/film-grade",
      parameters: { gamma: 1, saturation: 1 },
    });
    if (!transform) throw new Error("Expected transformation instance.");

    const context = {
      container: { width: 1920, height: 1080 },
      content: { width: 1920, height: 1080 },
      visualTime: 10,
      visualDuration: 100,
    };
    const live = applyTransformStack([transform], context, 10, {
      notifyLiveParams: false,
    });
    const exported = applyTransformStack([transform], context, 10, {
      notifyLiveParams: false,
    });

    expect(live.state.filters).toEqual([
      {
        type: "example.color-grade/film-grade",
        params: { gamma: 1, saturation: 1 },
      },
    ]);
    expect(exported.state.filters).toEqual(live.state.filters);

    const target = {
      position: { x: 0, y: 0, set: vi.fn() },
      scale: { x: 1, y: 1, set: vi.fn() },
      rotation: 0,
      filters: [],
    };
    filterApplicator(target, live.state, context.content);
    expect(target.filters).toHaveLength(1);
    expect(target.filters[0]).toMatchObject({ gamma: 1, saturation: 1 });
  });

  it("runs arbitrary trusted GLSL filters with the host Pixi singleton", () => {
    const scope = createScope("example.custom-shader");
    const api = createVloExtensionApi(scope);
    const update = vi.fn();
    const destroy = vi.fn();
    const createFilter = vi.fn(() => ({
      filter: api.runtime.pixi.Filter.from({
        gl: {
          vertex: `
            in vec2 aPosition;
            void main(void) { gl_Position = vec4(aPosition, 0.0, 1.0); }
          `,
          fragment: `
            out vec4 finalColor;
            void main(void) { finalColor = vec4(1.0); }
          `,
        },
      }),
      update,
      destroy,
    }));
    const registration = api.transformations.register({
      id: "custom-glsl",
      apiVersion: 1,
      kind: "trusted-filter",
      label: "Custom GLSL",
      defaultParameters: { seed: 42 },
      validateParameters: (parameters) =>
        typeof parameters.seed === "number",
      groups: [
        {
          id: "shader",
          title: "Shader",
          controls: [
            {
              type: "slider",
              name: "strength",
              label: "Strength",
              defaultValue: 0.5,
              min: 0,
              max: 1,
            },
            {
              type: "checkbox",
              name: "preserveLuma",
              label: "Preserve luma",
              defaultValue: true,
            },
            {
              type: "select",
              name: "curve",
              label: "Curve",
              defaultValue: "filmic",
              options: [
                { label: "Linear", value: "linear" },
                { label: "Filmic", value: "filmic" },
              ],
            },
          ],
        },
      ],
      createFilter,
    });
    disposers.push(() => registration.dispose());

    const transform = createAddTransform(
      "example.custom-shader/custom-glsl",
      true,
    );
    expect(transform?.parameters).toEqual({
      strength: 0.5,
      preserveLuma: true,
      curve: "filmic",
      seed: 42,
    });
    if (!transform) throw new Error("Expected trusted transformation.");

    const applied = applyTransformStack(
      [transform],
      {
        container: { width: 100, height: 100 },
        content: { width: 100, height: 100 },
      },
      0,
      { notifyLiveParams: false },
    );
    const target: ClipTransformTarget & { filters: Filter[] } = {
      position: { x: 0, y: 0, set: vi.fn() },
      scale: { x: 1, y: 1, set: vi.fn() },
      rotation: 0,
      filters: [],
    };

    filterApplicator(target, applied.state, { width: 100, height: 100 });
    const firstFilter = target.filters[0];
    expect(firstFilter).toBeInstanceOf(Filter);
    expect(createFilter).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(transform.parameters, {
      target,
      contentSize: { width: 100, height: 100 },
    });

    filterApplicator(target, applied.state, { width: 100, height: 100 });
    expect(target.filters[0]).toBe(firstFilter);
    expect(createFilter).toHaveBeenCalledOnce();

    filterApplicator(
      target,
      { ...applied.state, filters: [] },
      { width: 100, height: 100 },
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(target.filters).toEqual([]);

    filterApplicator(target, applied.state, { width: 100, height: 100 });
    expect(createFilter).toHaveBeenCalledTimes(2);

    registration.dispose();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(target.filters).toEqual([]);
    expect(getEntryByFilterName("example.custom-shader/custom-glsl")).toBeUndefined();
  });

  it("isolates invalid persisted parameters and reports the owning extension", () => {
    const report = vi.fn();
    const registration = extensionTransformationRegistry
      .bind(createScope("example.invalid-grade", report))
      .register({
        id: "grade",
        apiVersion: 1,
        kind: "host-filter",
        hostFilter: "hsl-adjustment",
        label: "Grade",
        groups: [
          {
            id: "grade",
            title: "Grade",
            controls: [
              {
                type: "slider",
                name: "hue",
                label: "Hue",
                defaultValue: 0,
                min: -180,
                max: 180,
              },
            ],
          },
        ],
      });
    disposers.push(() => registration.dispose());
    const state = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      filters: [],
    };

    dispatchTransform(
      state,
      {
        id: "bad-transform",
        type: "filter",
        filterName: "example.invalid-grade/grade",
        isEnabled: true,
        parameters: { hue: "not-a-number" },
      } as GenericFilterTransform,
      {
        container: { width: 100, height: 100 },
        content: { width: 100, height: 100 },
      },
    );

    expect(state.filters).toEqual([]);
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("invalid parameters"),
      { transformId: "bad-transform" },
    );
  });

  it("rejects non-host Pixi instances returned by trusted factories", () => {
    const report = vi.fn();
    const registration = extensionTransformationRegistry
      .bind(createScope("example.invalid-filter", report))
      .register({
        id: "invalid-filter",
        apiVersion: 1,
        kind: "trusted-filter",
        label: "Invalid filter",
        groups: [
          {
            id: "invalid",
            title: "Invalid",
            controls: [
              {
                type: "number",
                name: "amount",
                label: "Amount",
                defaultValue: 1,
                min: 0,
                max: 2,
              },
            ],
          },
        ],
        createFilter: () => ({ filter: {}, update: vi.fn() }),
      });
    disposers.push(() => registration.dispose());
    const transform = createAddTransform(
      "example.invalid-filter/invalid-filter",
      true,
    );
    if (!transform) throw new Error("Expected trusted transformation.");
    const applied = applyTransformStack(
      [transform],
      {
        container: { width: 100, height: 100 },
        content: { width: 100, height: 100 },
      },
      0,
      { notifyLiveParams: false },
    );
    const target = {
      position: { x: 0, y: 0, set: vi.fn() },
      scale: { x: 1, y: 1, set: vi.fn() },
      rotation: 0,
      filters: [],
    };

    filterApplicator(target, applied.state);

    expect(target.filters).toEqual([]);
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("failed while applying its filter"),
      expect.any(Error),
    );
  });

  it("registers executable trusted transformations beyond filters", () => {
    const registration = extensionTransformationRegistry
      .bind(createScope("example.motion"))
      .register({
        id: "offset-x",
        apiVersion: 1,
        kind: "trusted-transformation",
        label: "Custom X Offset",
        groups: [
          {
            id: "offset",
            title: "Offset",
            controls: [
              {
                type: "number",
                name: "amount",
                label: "Amount",
                defaultValue: 12,
                min: -10_000,
                max: 10_000,
                supportsSpline: true,
              },
            ],
          },
        ],
        apply: ({ state, transform }) => {
          state.x += Number(transform.parameters.amount);
        },
      });
    disposers.push(() => registration.dispose());

    const transform = createAddTransform("example.motion/offset-x");
    expect(transform).toMatchObject({
      type: "example.motion/offset-x",
      parameters: { amount: 12 },
    });
    if (!transform) throw new Error("Expected trusted transformation.");

    const result = applyTransformStack(
      [transform],
      {
        container: { width: 100, height: 100 },
        content: { width: 100, height: 100 },
      },
      0,
      { notifyLiveParams: false },
    );
    expect(result.state.x).toBe(62);

    transform.parameters.amount = {
      type: "spline",
      points: [
        { time: 0, value: 0 },
        { time: 10, value: 20 },
      ],
    };
    const animated = applyTransformStack(
      [transform],
      {
        container: { width: 100, height: 100 },
        content: { width: 100, height: 100 },
      },
      5,
      { notifyLiveParams: false },
    );
    expect(animated.state.x).toBe(60);

    registration.dispose();
    expect(getMissingExtensionTransformationId(transform)).toBe(
      "example.motion/offset-x",
    );
  });

  it("rejects invalid metadata and releases IDs on disposal", () => {
    const registry = new ExtensionTransformationRegistry();
    const scope = createScope("example.owner");
    const registration = registerColorGrade(registry, "example.owner");

    expect(() => registerColorGrade(registry, "example.owner")).toThrow(
      /already registered/,
    );
    registration.dispose();
    expect(() => registerColorGrade(registry, "example.owner")).not.toThrow();

    expect(() =>
      registry.bind(scope).register({
        id: "bad-parameter",
        apiVersion: 1,
        kind: "host-filter",
        hostFilter: "hsl-adjustment",
        label: "Bad",
        groups: [
          {
            id: "bad",
            title: "Bad",
            controls: [
              {
                type: "slider",
                name: "gamma",
                label: "Unsupported",
                defaultValue: 1,
                min: 0,
                max: 2,
              },
            ],
          },
        ],
      }),
    ).toThrow(/does not support parameter 'gamma'/);
  });

  it("registers a newly allow-listed host filter and rejects its foreign parameters", () => {
    const registry = new ExtensionTransformationRegistry();
    const registration = registry.bind(createScope("example.bloom")).register({
      id: "soft-bloom",
      apiVersion: 1,
      kind: "host-filter",
      hostFilter: "bloom",
      label: "Soft Bloom",
      groups: [
        {
          id: "bloom",
          title: "Bloom",
          controls: [
            {
              type: "slider",
              name: "strength",
              label: "Strength",
              defaultValue: 2,
              min: 0,
              max: 20,
              step: 0.1,
            },
          ],
        },
      ],
    });

    expect(registration.id).toBe("example.bloom/soft-bloom");
    expect(
      registry.listDefinitions().map((definition) => definition.filterName),
    ).toContain("example.bloom/soft-bloom");

    expect(() =>
      registry.bind(createScope("example.bloom-bad")).register({
        id: "bad-bloom",
        apiVersion: 1,
        kind: "host-filter",
        hostFilter: "bloom",
        label: "Bad Bloom",
        groups: [
          {
            id: "bloom",
            title: "Bloom",
            controls: [
              {
                type: "slider",
                name: "gamma",
                label: "Gamma",
                defaultValue: 1,
                min: 0,
                max: 5,
              },
            ],
          },
        ],
      }),
    ).toThrow(/does not support parameter 'gamma'/);
  });

  it("allows the same local ID for different extension owners", () => {
    const registry = new ExtensionTransformationRegistry();
    const first = registerColorGrade(registry, "example.first");
    const second = registerColorGrade(registry, "example.second");

    expect(first.id).toBe("example.first/film-grade");
    expect(second.id).toBe("example.second/film-grade");
    expect(registry.listDefinitions().map((entry) => entry.filterName)).toEqual([
      "example.first/film-grade",
      "example.second/film-grade",
    ]);
  });

  it("rolls registration back when extension activation fails", async () => {
    const registry = new ExtensionTransformationRegistry();
    const host = new ExtensionHost<{ transformations: ExtensionTransformationApi }>({
      sdkVersion: "1.0.0",
      createApi: (scope) => ({ transformations: registry.bind(scope) }),
    });

    await expect(
      host.activate(
        { id: "example.rollback", version: "1.0.0" },
        {
          activate: (context) => {
            context.api.transformations.register({
              id: "grade",
              apiVersion: 1,
              kind: "host-filter",
              hostFilter: "hsl-adjustment",
              label: "Grade",
              groups: [
                {
                  id: "grade",
                  title: "Grade",
                  controls: [
                    {
                      type: "slider",
                      name: "hue",
                      label: "Hue",
                      defaultValue: 0,
                      min: -180,
                      max: 180,
                    },
                  ],
                },
              ],
            });
            throw new Error("activation failed");
          },
        },
      ),
    ).rejects.toThrow(/Failed to activate/);
    expect(registry.listDefinitions()).toEqual([]);
  });
});
