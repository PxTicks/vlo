import { useEffect } from "react";
import type { FederatedPointerEvent, Sprite } from "pixi.js";

interface SpriteInteractionHandlers {
  onSpritePointerDown: (e: FederatedPointerEvent) => void;
}

export function useSpriteInteraction(
  sprite: Sprite | null,
  interactions: SpriteInteractionHandlers,
  enabled: boolean = true,
) {
  useEffect(() => {
    if (!sprite) return;

    if (!enabled) {
      // eslint-disable-next-line react-hooks/immutability
      sprite.eventMode = "passive";
      sprite.cursor = "default";
      return;
    }

    sprite.eventMode = "static";
    sprite.cursor = "grab";

    sprite.on("pointerdown", interactions.onSpritePointerDown);

    return () => {
      sprite.off("pointerdown", interactions.onSpritePointerDown);
    };
  }, [enabled, sprite, interactions]);
}
