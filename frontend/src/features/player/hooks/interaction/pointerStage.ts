import type { Application, Container, FederatedPointerEvent } from "pixi.js";

export type PointerMoveHandler = (e: FederatedPointerEvent) => void;
export type PointerUpHandler = (e?: FederatedPointerEvent) => void;

export function bindStagePointerListeners(
  app: Application | null,
  onPointerMove: PointerMoveHandler,
  onPointerUp: PointerUpHandler,
) {
  app?.stage.on("pointermove", onPointerMove);
  app?.stage.on("pointerup", onPointerUp);
  app?.stage.on("pointerupoutside", onPointerUp);
}

export function unbindStagePointerListeners(
  app: Application | null,
  onPointerMove: PointerMoveHandler,
  onPointerUp: PointerUpHandler,
) {
  app?.stage.off("pointermove", onPointerMove);
  app?.stage.off("pointerup", onPointerUp);
  app?.stage.off("pointerupoutside", onPointerUp);
}

export function toViewportLocal(
  viewport: Container,
  global: { x: number; y: number },
) {
  return viewport.toLocal(global);
}
