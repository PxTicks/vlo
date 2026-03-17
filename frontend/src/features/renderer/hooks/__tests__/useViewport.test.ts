// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Application } from "pixi.js";
import { useViewport } from "../useViewport";

// --- Mocks Setup ---
const { mockViewportInstance, MockViewportConstructor } = vi.hoisted(() => {
  const instance = {
    pinch: vi.fn().mockReturnThis(),
    wheel: vi.fn().mockReturnThis(),
    decelerate: vi.fn().mockReturnThis(),
    clampZoom: vi.fn(),
    addChild: vi.fn(),
    moveCenter: vi.fn(),
    fit: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
    sortableChildren: false,
    mask: null,
  };

  // Use a regular function so 'new' works, but wrap in vi.fn to spy calls
  const MockConstructor = vi.fn(function (this: unknown) {
    return instance;
  });

  return {
    mockViewportInstance: instance,
    MockViewportConstructor: MockConstructor,
  };
});

vi.mock("pixi-viewport", () => ({
  Viewport: MockViewportConstructor,
}));

vi.mock("pixi.js", async () => {
  const actual = await vi.importActual("pixi.js");
  return {
    ...actual,
    Graphics: class {
      rect = vi.fn().mockReturnThis();
      fill = vi.fn().mockReturnThis();
      clear = vi.fn();
    },
    Application: vi.fn(),
  };
});

// Mock App
const mockApp = {
  stage: {
    addChild: vi.fn(),
    removeChild: vi.fn(),
    destroyed: false,
  },
  renderer: {
    events: {},
  },
  ticker: {},
} as unknown as Application;

describe("useViewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes and centers viewport correctly with latest config", () => {
    const initialConfig = {
      screenWidth: 100,
      screenHeight: 100,
      logicalWidth: 100,
      logicalHeight: 100,
    };

    const finalConfig = {
      screenWidth: 800,
      screenHeight: 600,
      logicalWidth: 1000,
      logicalHeight: 1000,
    };

    // 1. Initial Render: App is null, Config is Initial
    const { rerender } = renderHook(
      ({ app, config }) => useViewport(app, config),
      {
        initialProps: {
          app: null as Application | null,
          config: initialConfig,
        },
      },
    );

    // 2. Rerender: App is provided, Config is UPDATED
    // The hook should use this NEW config for initialization
    rerender({ app: mockApp, config: finalConfig });

    // 1. Check Construction
    expect(MockViewportConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        screenWidth: 800,
        screenHeight: 600,
        worldWidth: 1000,
        worldHeight: 1000,
      }),
    );

    // 2. Check Centering Logic
    // Should use finalConfig dimensions (1000 / 2 = 500)
    // If it used initialConfig, it would be (50, 50)
    expect(mockViewportInstance.moveCenter).toHaveBeenCalledWith(500, 500);
    expect(mockViewportInstance.fit).toHaveBeenCalledWith(true);
  });

  it("initializes only once", () => {
    const config = {
      screenWidth: 800,
      screenHeight: 600,
      logicalWidth: 1000,
      logicalHeight: 1000,
    };

    const { rerender } = renderHook(({ app, conf }) => useViewport(app, conf), {
      initialProps: { app: mockApp, conf: config },
    });

    expect(MockViewportConstructor).toHaveBeenCalledTimes(1);

    // Rerender with same props
    rerender({ app: mockApp, conf: config });
    expect(MockViewportConstructor).toHaveBeenCalledTimes(1);
  });
});
