import { useEffect } from "react";
import type { FederatedPointerEvent, Sprite } from "pixi.js";

interface SpriteInteractionHandlers {
  onSpritePointerDown: (e: FederatedPointerEvent) => void;
}

export function useSpriteInteraction(
  sprite: Sprite | null,
  interactions: SpriteInteractionHandlers,
) {
  useEffect(() => {
    if (!sprite) return;

    // eslint-disable-next-line react-hooks/immutability
    sprite.eventMode = "static";
    sprite.cursor = "grab";

    sprite.on("pointerdown", interactions.onSpritePointerDown);

    return () => {
      sprite.off("pointerdown", interactions.onSpritePointerDown);
    };
  }, [sprite, interactions]);
}
