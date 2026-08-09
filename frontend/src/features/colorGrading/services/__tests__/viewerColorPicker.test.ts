// @vitest-environment jsdom
import { Container, Rectangle } from "pixi.js";
import type { Application } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import {
  clearActivePixiApplication,
  setActivePixiApplication,
  setActivePixiContentTarget,
} from "../../../../core/pixi/activeApplication";
import { markPixiPreviewOnly } from "../../../../core/pixi/previewOnly";
import { pickColorFromViewer } from "../viewerColorPicker";

describe("viewer color picker", () => {
  it("samples content with preview-only descendants excluded", async () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    } as DOMRect);
    const content = new Container();
    const preview = new Container();
    content.addChild(preview);
    markPixiPreviewOnly(preview);
    const extractPixels = vi.fn(() => {
      expect(preview.renderable).toBe(false);
      return {
        pixels: new Uint8Array([128, 64, 32, 128]),
        width: 1,
        height: 1,
      };
    });
    const application = {
      canvas,
      screen: { width: 100, height: 100 },
      renderer: { extract: { pixels: extractPixels } },
    } as unknown as Application;
    setActivePixiApplication(application);
    setActivePixiContentTarget(content, new Rectangle(0, 0, 100, 100));

    try {
      const picked = pickColorFromViewer();
      canvas.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          clientX: 20,
          clientY: 30,
        }),
      );

      await expect(picked).resolves.toEqual([1, 0.5, 0.25]);
      expect(preview.renderable).toBe(true);
      expect(extractPixels).toHaveBeenCalledOnce();
    } finally {
      clearActivePixiApplication(application);
      canvas.remove();
    }
  });
});
