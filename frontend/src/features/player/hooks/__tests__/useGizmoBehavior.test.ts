import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGizmoBehavior } from "../useGizmoBehavior";
import { Container, Sprite, Texture, Application } from "pixi.js";
import type { TransformInteractionHandlers } from "../interaction/useTransformInteractionController";

// Mock SelectionGizmo class
vi.mock("../../utils/SelectionGizmo", () => {
  return {
    SelectionGizmo: vi.fn().mockImplementation(function () {
      return {
        zIndex: 0,
        update: vi.fn(),
        destroy: vi.fn(),
        getHandle: vi.fn(),
      };
    }),
  };
});

import { SelectionGizmo } from "../../utils/SelectionGizmo";

describe("useGizmoBehavior", () => {
  let mockSprite: Sprite;
  let mockViewport: Container;
  let mockApp: Application;
  let interactions: TransformInteractionHandlers;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Setup PIXI mocks
    mockSprite = new Sprite(Texture.EMPTY);
    mockSprite.position.set(100, 100);
    mockSprite.scale.set(1, 1);
    mockSprite.rotation = 0;

    // Mock viewport
    mockViewport = {
      addChild: vi.fn(),
      removeChild: vi.fn(),
      toLocal: vi.fn(),
      scale: { x: 1, y: 1 }, // Required for current update loop
    } as unknown as Container;

    // Mock app stage events
    mockApp = {
      stage: {
        on: vi.fn(),
        off: vi.fn(),
      },
      ticker: {
        add: vi.fn((fn) => fn()), // Auto-run callback immediately
        remove: vi.fn(),
      },
    } as unknown as Application;

    interactions = {
      onSpritePointerDown: vi.fn(),
      onHandlePointerDown: vi.fn(),
    };
  });

  it("should call gizmo.update on tick", () => {
    // 1. Initial Render
    renderHook(() =>
      useGizmoBehavior(mockSprite, true, mockApp, mockViewport, interactions),
    );

    // Verify gizmo was instantiated
    expect(SelectionGizmo).toHaveBeenCalled();
    const gizmoMock = vi.mocked(SelectionGizmo).mock.instances[0] as unknown as {
      update: Mock;
      destroy: Mock;
    };

    // Verify gizmo was added to viewport
    expect(mockViewport.addChild).toHaveBeenCalledWith(gizmoMock);

    // Verify update was called immediately (due to ticker.add mock running fn())
    expect(gizmoMock.update).toHaveBeenCalledWith(mockSprite, 1);

    // 2. Simulate Ticker Update
    // Ensure that our ticker mock logic holds.
    // If we want to simulate a SECOND frame:

    // Retrieve the ticker callback passed to .add
    const tickerCallback = vi.mocked(mockApp.ticker.add).mock.calls[0][0] as () => void;
    expect(tickerCallback).toBeTypeOf("function");

    // Change viewport scale to check if update receives new value
    mockViewport.scale.x = 2;

    // Run tick manually
    tickerCallback();

    expect(gizmoMock.update).toHaveBeenCalledWith(mockSprite, 2);
  });
});
