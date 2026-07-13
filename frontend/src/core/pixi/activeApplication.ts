import type { Application, Container, Rectangle } from "pixi.js";

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
