import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { Sprite } from "pixi.js";
import { useSpriteInteraction } from "../useSpriteInteraction";
import type { TransformInteractionHandlers } from "../interaction/useTransformInteractionController";

describe("useSpriteInteraction", () => {
  it("binds and unbinds sprite pointerdown to controller handler", () => {
    const sprite = new Sprite();
    sprite.on = vi.fn();
    sprite.off = vi.fn();

    const interactions: TransformInteractionHandlers = {
      onSpritePointerDown: vi.fn(),
      onHandlePointerDown: vi.fn(),
    };

    const { unmount } = renderHook(() =>
      useSpriteInteraction(sprite, interactions),
    );

    expect(sprite.eventMode).toBe("static");
    expect(sprite.cursor).toBe("grab");
    expect(sprite.on).toHaveBeenCalledWith(
      "pointerdown",
      interactions.onSpritePointerDown,
    );

    unmount();

    expect(sprite.off).toHaveBeenCalledWith(
      "pointerdown",
      interactions.onSpritePointerDown,
    );
  });
});
