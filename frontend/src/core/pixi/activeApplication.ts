import type { Application, Container, Rectangle } from "pixi.js";
import { withoutPixiPreviewOnlyNodes } from "./previewOnly";

let activeApplication: Application | null = null;
const activeApplicationListeners = new Set<() => void>();
let activeContentTarget: {
  target: Container;
  frame: Rectangle;
} | null = null;

export function setActivePixiApplication(application: Application): void {
  activeApplication = application;
  activeContentTarget = null;
  for (const listener of activeApplicationListeners) listener();
}

export function clearActivePixiApplication(application: Application): void {
  if (activeApplication !== application) return;
  activeApplication = null;
  activeContentTarget = null;
  for (const listener of activeApplicationListeners) listener();
}

export function getActivePixiApplication(): Application | null {
  return activeApplication;
}

export function subscribeActivePixiApplication(listener: () => void): () => void {
  activeApplicationListeners.add(listener);
  return () => activeApplicationListeners.delete(listener);
}

export function setActivePixiContentTarget(
  target: Container,
  frame: Rectangle,
): void {
  activeContentTarget = { target, frame };
}

export function clearActivePixiContentTarget(target: Container): void {
  if (activeContentTarget?.target === target) activeContentTarget = null;
}

export function getActivePixiContentTarget(): typeof activeContentTarget {
  return activeContentTarget;
}

/**
 * The sole readback path for active viewer content. Preview-only descendants
 * are excluded for the synchronous Pixi extraction and immediately restored.
 */
export function readActivePixiContentPixels(
  frame: Rectangle,
  resolution: number,
) {
  const application = activeApplication;
  if (!application || !activeContentTarget) return null;
  const { target } = activeContentTarget;
  return withoutPixiPreviewOnlyNodes(target, () =>
    application.renderer.extract.pixels({
      target,
      frame,
      resolution,
    }),
  );
}
