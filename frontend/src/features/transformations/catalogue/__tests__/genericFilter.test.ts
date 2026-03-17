import { describe, it, expect, vi } from "vitest";
import { filterHandler, filterApplicator } from "../filterFactory";
import { TransformationRegistry } from "../TransformationRegistry";
import type { GenericFilterTransform } from "../../types";
import type { TransformState } from "../types";
import { Sprite, Filter, Matrix } from "pixi.js";

// Mock Registry
const MockFilter = class extends Filter {
  constructor() {
    super({} as unknown as ConstructorParameters<typeof Filter>[0]);
  }
  foo: number = 0;
  enabled: boolean = false;
  point: { x: number; y: number } | null = null;
};

const ScaledMockFilter = class extends Filter {
  constructor() {
    super({} as unknown as ConstructorParameters<typeof Filter>[0]);
  }
  foo: number = 0;
};

// Add mock entry to registry for testing
(TransformationRegistry as unknown[]).push({
  type: "filter",
  filterName: "MockFilter",
  FilterClass: MockFilter,
  label: "Mock Filter",
  isDefault: false,
  uiConfig: { groups: [] },
});

(TransformationRegistry as unknown[]).push({
  type: "filter",
  filterName: "ScaledMockFilter",
  FilterClass: ScaledMockFilter,
  label: "Scaled Mock Filter",
  isDefault: false,
  uiConfig: { groups: [] },
  filterParameterScale: {
    foo: "worldX",
  },
  filterPadding: (params: Readonly<Record<string, unknown>>) =>
    typeof params.foo === "number" ? params.foo : 0,
});

// Mock PIXI Sprite
vi.mock("pixi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pixi.js")>();
  const mockedPixi = {
    ...actual,
  } as typeof import("pixi.js") & Record<string, unknown>;

  mockedPixi.Filter = class {} as unknown as typeof actual.Filter;
  mockedPixi.Sprite = class {
    filters: Filter[] = [];
    alpha = 1;
    tint = 0xffffff;
  } as unknown as typeof actual.Sprite;

  // Automatically mock any class ending in 'Filter'
  for (const key of Object.keys(mockedPixi)) {
    if (key.endsWith("Filter") && key !== "Filter") {
      mockedPixi[key] = class extends (mockedPixi.Filter as typeof actual.Filter) {};
    }
  }

  return mockedPixi;
});

describe("Generic Filter System", () => {
  const mockContext = {
    container: { width: 100, height: 100 },
    content: { width: 50, height: 50 },
    time: 0,
  };

  const createBaseState = (): TransformState => ({
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    filters: [],
  });

  describe("filterHandler", () => {
    it("should push generic filter op to stack", () => {
      const state = createBaseState();
      const transform: GenericFilterTransform = {
        id: "1",
        type: "filter",
        isEnabled: true,
        filterName: "MockFilter",
        parameters: {
          foo: 42,
          enabled: true,
          point: { x: 10, y: 20 },
        },
      };

      filterHandler(state, transform, mockContext);

      expect(state.filters).toHaveLength(1);
      expect(state.filters[0]).toEqual({
        type: "MockFilter",
        params: {
          foo: 42,
          enabled: true,
          point: { x: 10, y: 20 },
        },
      });
    });
    it("should resolve spline parameters in filterHandler", () => {
      const state = createBaseState();
      const transform: GenericFilterTransform = {
        id: "2",
        type: "filter",
        isEnabled: true,
        filterName: "MockFilter",
        parameters: {
          foo: {
            type: "spline",
            points: [
              { time: 0, value: 0 },
              { time: 10, value: 100 },
            ],
          },
        },
      };

      // At time 5, value should be 50
      filterHandler(state, transform, { ...mockContext, time: 5 });

      expect(state.filters).toHaveLength(1);
      expect(state.filters[0].type).toBe("MockFilter");
      expect(state.filters[0].params.foo).toBeCloseTo(50);
    });
  });

  describe("filterApplicator", () => {
    it("keeps TwistFilter offsets in the input-local frame", () => {
      const twistEntry = TransformationRegistry.find(
        (entry) => entry.filterName === "TwistFilter",
      );

      expect(twistEntry?.filterParameterPoints).toEqual([
        { x: "offsetX", y: "offsetY", space: "inputLocal" },
      ]);
    });

    it("should instantiate and apply properties from registry", () => {
      const state = createBaseState();
      state.filters.push({
        type: "MockFilter",
        params: { foo: 99 },
      });

      const sprite = new Sprite();
      filterApplicator(sprite, state);

      expect(sprite.filters).toHaveLength(1);
      const instance = sprite.filters![0] as InstanceType<typeof MockFilter>;
      expect(instance).toBeInstanceOf(MockFilter);
      expect(instance.foo).toBe(99);
    });

    it("should reuse existing filter instances", () => {
      const state = createBaseState();
      state.filters.push({ type: "MockFilter", params: { foo: 1 } });

      const sprite = new Sprite();
      const existing = new MockFilter();
      sprite.filters = [existing];

      filterApplicator(sprite, state);

      expect(sprite.filters).toHaveLength(1);
      expect(sprite.filters![0]).toBe(existing);
      expect((sprite.filters![0] as InstanceType<typeof MockFilter>).foo).toBe(
        1,
      );
    });

    it("should handle unknown filters gracefully", () => {
      const state = createBaseState();
      state.filters.push({ type: "UnknownFilter", params: {} });

      const sprite = new Sprite();
      filterApplicator(sprite, state);

      expect(sprite.filters).toHaveLength(0);
    });

    it("scales spatial filter params from the target world transform", () => {
      const state = createBaseState();
      state.filters.push({
        type: "ScaledMockFilter",
        params: { foo: 4 },
      });

      const sprite = new Sprite() as Sprite & {
        getGlobalTransform: () => Matrix;
      };
      sprite.getGlobalTransform = () => new Matrix(2, 0, 0, 3, 0, 0);

      filterApplicator(sprite, state);

      expect(sprite.filters).toHaveLength(1);
      const instance = sprite.filters![0] as InstanceType<typeof ScaledMockFilter>;
      expect(instance.foo).toBe(8);
      expect(instance.padding).toBe(8);
    });

    it("maps normalized point params into the padded input frame", () => {
      const PointMockFilter = class extends Filter {
        constructor() {
          super({} as unknown as ConstructorParameters<typeof Filter>[0]);
        }
        centerX: number = 0;
        centerY: number = 0;
      };

      (TransformationRegistry as unknown[]).push({
        type: "filter",
        filterName: "PointMockFilter",
        FilterClass: PointMockFilter,
        label: "Point Mock",
        isDefault: false,
        uiConfig: { groups: [] },
        filterParameterPoints: [
          { x: "centerX", y: "centerY", space: "inputLocal" },
        ],
        filterPadding: () => 20,
      });

      const state = createBaseState();
      state.filters.push({
        type: "PointMockFilter",
        params: { centerX: 0.75, centerY: 0.5 },
      });

      const target = {
        filters: [],
        texture: { width: 200, height: 100 },
        anchor: { x: 0.5, y: 0.5 },
        getGlobalTransform: () => ({
          a: 2,
          b: 0,
          c: 0,
          d: 2,
          tx: 500,
          ty: 300,
        }),
      } as unknown as Sprite;

      filterApplicator(target, state);

      expect(target.filters).toHaveLength(1);
      const instance = target.filters![0] as InstanceType<typeof PointMockFilter>;
      expect(instance.centerX).toBe(320);
      expect(instance.centerY).toBe(120);
      expect(instance.padding).toBe(20);
    });

    it("uses full object bounds (not viewport-clipped) for input-local points", () => {
      const UnclippedPointMockFilter = class extends Filter {
        constructor() {
          super({} as unknown as ConstructorParameters<typeof Filter>[0]);
        }
        centerX: number = 0;
        centerY: number = 0;
      };

      (TransformationRegistry as unknown[]).push({
        type: "filter",
        filterName: "UnclippedPointMockFilter",
        FilterClass: UnclippedPointMockFilter,
        label: "Unclipped Point Mock",
        isDefault: false,
        uiConfig: { groups: [] },
        filterParameterPoints: [
          { x: "centerX", y: "centerY", space: "inputLocal" },
        ],
      });

      const state = createBaseState();
      state.filters.push({
        type: "UnclippedPointMockFilter",
        params: { centerX: 0.5, centerY: 0.5 },
      });

      const target = {
        filters: [],
        parent: { screenWidth: 250, screenHeight: 180, parent: null },
        texture: { width: 200, height: 100 },
        anchor: { x: 0.5, y: 0.5 },
        getGlobalTransform: () => ({
          a: 2,
          b: 0,
          c: 0,
          d: 2,
          tx: 120,
          ty: 90,
        }),
      } as unknown as Sprite;

      filterApplicator(target, state);

      expect(target.filters).toHaveLength(1);
      const instance = target.filters![0] as InstanceType<
        typeof UnclippedPointMockFilter
      >;
      // Object bounds: minX = -80 (from -100*2+120), width = 400
      // Center at world (120, 90) → filter-local: (120 - (-80)) = 200, (90 - (-10)) = 100
      // PixiJS uses full object bounds for the filter texture, not viewport-clipped bounds.
      expect(instance.centerX).toBe(200);
      expect(instance.centerY).toBe(100);
    });

    it("maps normalized point params into global screen space", () => {
      const GlobalPointMockFilter = class extends Filter {
        constructor() {
          super({} as unknown as ConstructorParameters<typeof Filter>[0]);
        }
        offsetX: number = 0;
        offsetY: number = 0;
      };

      (TransformationRegistry as unknown[]).push({
        type: "filter",
        filterName: "GlobalPointMockFilter",
        FilterClass: GlobalPointMockFilter,
        label: "Global Point Mock",
        isDefault: false,
        uiConfig: { groups: [] },
        filterParameterPoints: [
          { x: "offsetX", y: "offsetY", space: "screenGlobal" },
        ],
      });

      const state = createBaseState();
      state.filters.push({
        type: "GlobalPointMockFilter",
        params: { offsetX: 0.75, offsetY: 0.5 },
      });

      const target = {
        filters: [],
        texture: { width: 200, height: 100 },
        anchor: { x: 0.5, y: 0.5 },
        getGlobalTransform: () => ({
          a: 2,
          b: 0,
          c: 0,
          d: 2,
          tx: 500,
          ty: 300,
        }),
      } as unknown as Sprite;

      filterApplicator(target, state);

      expect(target.filters).toHaveLength(1);
      const instance = target.filters![0] as InstanceType<
        typeof GlobalPointMockFilter
      >;
      expect(instance.offsetX).toBe(600);
      expect(instance.offsetY).toBe(300);
    });
  });
});
