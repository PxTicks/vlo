import type { Application, Container, Rectangle } from "pixi.js";

let activeApplication: Application | null = null;
let activeContentTarget: {
  target: Container;
  frame: Rectangle;
} | null = null;

export function setActivePixiApplication(application: Application): void {
  activeApplication = application;
  activeContentTarget = null;
}

export function clearActivePixiApplication(application: Application): void {
  if (activeApplication !== application) return;
  activeApplication = null;
  activeContentTarget = null;
}

export function getActivePixiApplication(): Application | null {
  return activeApplication;
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
