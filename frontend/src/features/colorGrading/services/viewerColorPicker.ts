import { Point, Rectangle } from "pixi.js";
import {
  getActivePixiApplication,
  getActivePixiContentTarget,
  readActivePixiContentPixels,
} from "../../../core/pixi/activeApplication";
import type { Rgb } from "../../../core/color";

const EYEDROPPER_CURSOR_CLASS = "eyedropper-cursor";

function sampleViewerColor(event: PointerEvent): Rgb | null {
  const application = getActivePixiApplication();
  const content = getActivePixiContentTarget();
  if (!application || !content || event.target !== application.canvas) return null;

  const bounds = application.canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const screen = new Point(
    ((event.clientX - bounds.left) / bounds.width) * application.screen.width,
    ((event.clientY - bounds.top) / bounds.height) * application.screen.height,
  );
  const local = content.target.worldTransform.applyInverse(screen);
  if (!content.frame.contains(local.x, local.y)) return null;

  const result = readActivePixiContentPixels(
    new Rectangle(local.x, local.y, 1, 1),
    1,
  );
  if (!result) return null;
  const alpha = result.pixels[3] / 255;
  if (alpha <= 1e-6) return [0, 0, 0];
  return [
    Math.min(1, result.pixels[0] / 255 / alpha),
    Math.min(1, result.pixels[1] / 255 / alpha),
    Math.min(1, result.pixels[2] / 255 / alpha),
  ];
}

export function pickColorFromViewer(): Promise<Rgb> {
  const application = getActivePixiApplication();
  if (!application) return Promise.reject(new Error("Viewer is unavailable"));

  return new Promise((resolve, reject) => {
    const canvas = application.canvas;
    canvas.classList.add(EYEDROPPER_CURSOR_CLASS);

    const cleanup = (): void => {
      canvas.classList.remove(EYEDROPPER_CURSOR_CLASS);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
    const onPointerDown = (event: PointerEvent): void => {
      const color = sampleViewerColor(event);
      if (!color) return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      resolve(color);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      cleanup();
      reject(new Error("Picking cancelled"));
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
  });
}
