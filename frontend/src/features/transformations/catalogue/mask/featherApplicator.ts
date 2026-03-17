import type {
  StateApplicator,
  ClipTransformTarget,
  TransformState,
} from "../types";
import {
  Sprite,
  BlurFilter,
  ColorMatrixFilter,
  Container,
  MaskFilter,
  type Filter,
} from "pixi.js";
import { createMaskCleanupFilter } from "./maskCleanupFilter";
import { createMaskBinaryThresholdFilter } from "./maskBinaryThresholdFilter";

const FEATHER_RIG_KEY = "__vlo_feather_rig";
const BLUR_SCALE = 0.5;

interface FeatherRig {
  bottomLayer: Sprite;
  maskSprite: Sprite;
  bottomBlur: BlurFilter;
  bottomBoost: ColorMatrixFilter;
  bottomThreshold: Filter;
  softBlur: BlurFilter;
  twoWayBlur: BlurFilter;
  bottomCleanup: Filter;
  softCleanup: Filter;
  alphaMaskFilter: MaskFilter | null;
  lastAlphaMaskId: number | null;
  lastMode: "grow_only" | "hard_outer" | "soft_inner" | "two_way" | null;
}

/**
 * Applicator for mask edge operations.
 * Because feathering requires bleeding outward or choking inward without modifying
 * the original texture's pixels, it uses a compositing strategy by creating
 * sibling companion sprites.
 */
export const featherApplicator: StateApplicator = (
  target: ClipTransformTarget,
  state: TransformState,
) => {
  if (!(target instanceof Sprite)) return;
  const sprite = target;
  const container = sprite.parent as Container;

  // We need the parent container to add sibling background sprites.
  if (!container) return;

  const featherState = state.feather;
  const maskGrowState = state.maskGrow;
  const growAmount = maskGrowState?.amount ?? 0;
  const hasGrow = growAmount > 0;
  const hasFeather = !!featherState && featherState.amount > 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rig = (sprite as any)[FEATHER_RIG_KEY] as FeatherRig | undefined;

  // Cleanup if no edge operation is active.
  if (!hasGrow && !hasFeather) {
    if (rig) {
      if (sprite.mask === rig.maskSprite) {
        sprite.mask = null;
      }
      sprite.filters = [];
      container.filters = [];
      rig.bottomLayer.destroy();
      rig.maskSprite.destroy();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (sprite as any)[FEATHER_RIG_KEY];
    }
    return;
  }

  // Initialize rig if missing
  if (!rig) {
    rig = {
      bottomLayer: new Sprite(),
      maskSprite: new Sprite(),
      bottomBlur: new BlurFilter(),
      bottomBoost: new ColorMatrixFilter(),
      bottomThreshold: createMaskBinaryThresholdFilter(),
      softBlur: new BlurFilter(),
      twoWayBlur: new BlurFilter(),
      bottomCleanup: createMaskCleanupFilter(),
      softCleanup: createMaskCleanupFilter(),
      alphaMaskFilter: null,
      lastAlphaMaskId: null,
      lastMode: null,
    };

    // Configure boost matrix (Alpha * 3) for Outer
    rig.bottomBoost.matrix = [
      1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 3, 0,
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sprite as any)[FEATHER_RIG_KEY] = rig;
  }

  // Guard: skip if the sprite's texture source is missing or destroyed.
  // This prevents BlurFilter from crashing in getAdjustedBlendModeBlend
  // when a SAM2 mask texture is swapped/destroyed between frames.
  const texSource = sprite.texture?.source;
  if (!texSource || (texSource as { destroyed?: boolean }).destroyed) {
    rig.bottomLayer.filters = [];
    rig.maskSprite.filters = [];
    sprite.filters = [];
    container.filters = [];
    rig.bottomLayer.visible = false;
    rig.maskSprite.visible = false;
    return;
  }

  // Sync textures — restore visibility after a guard-skip
  rig.bottomLayer.texture = sprite.texture;
  rig.maskSprite.texture = sprite.texture;
  rig.bottomLayer.visible = true;
  rig.maskSprite.visible = true;

  // Sync spatial transforms
  const syncTransform = (companion: Sprite) => {
    companion.position.copyFrom(sprite.position);
    companion.scale.copyFrom(sprite.scale);
    companion.rotation = sprite.rotation;
    companion.anchor.copyFrom(sprite.anchor);
    companion.pivot.copyFrom(sprite.pivot);
    companion.alpha = sprite.alpha;
  };

  syncTransform(rig.bottomLayer);
  syncTransform(rig.maskSprite);

  const mode = featherState?.mode ?? "hard_outer";
  const featherAmount = featherState?.amount ?? 0;
  rig.softBlur.strength = featherAmount * BLUR_SCALE;
  rig.twoWayBlur.strength = featherAmount * BLUR_SCALE;

  // Extract any existing AlphaMask effect from the Sprite (e.g. from VLO's SpriteClipMaskController)
  // because rig sprites just use the unmasked `sprite.texture`.
  // We MUST apply the same mask to the rig BEFORE blurring it, otherwise we're blurring the unmasked video.
  const alphaMaskEffect = sprite.effects?.find(
    (e) => "mask" in e && "inverse" in e,
  ) as { mask: Sprite | Container; inverse: boolean } | undefined;

  // Cache the MaskFilter on the rig — only recreate when the alpha mask identity changes.
  const currentMaskId = alphaMaskEffect
    ? (alphaMaskEffect.mask as Sprite).uid ?? null
    : null;
  if (currentMaskId !== rig.lastAlphaMaskId) {
    rig.alphaMaskFilter = alphaMaskEffect
      ? new MaskFilter({
          sprite: alphaMaskEffect.mask as Sprite,
          inverse: alphaMaskEffect.inverse,
        })
      : null;
    rig.lastAlphaMaskId = currentMaskId;
  }

  // Helper to build the filter array injecting cleanup and alpha mask.
  const buildFilters = (cleanup: Filter, ...filters: Filter[]) => {
    const arr: Filter[] = [cleanup];
    if (rig!.alphaMaskFilter) {
      arr.push(rig!.alphaMaskFilter);
    }
    return [...arr, ...filters];
  };

  // Clear filters from layers that are being removed on mode switch
  const modeKey: FeatherRig["lastMode"] = hasFeather ? mode : "grow_only";
  if (rig.lastMode !== null && rig.lastMode !== modeKey) {
    rig.bottomLayer.filters = [];
    rig.maskSprite.filters = [];
    sprite.filters = [];
    container.filters = [];
  }
  rig.lastMode = modeKey;

  if (!hasFeather) {
    // Grow-only: blur + boost + threshold to produce a binary grown mask.
    rig.bottomBlur.strength = growAmount * BLUR_SCALE;
    sprite.mask = null;
    sprite.filters = [];
    container.filters = [];
    rig.bottomLayer.filters = buildFilters(
      rig.bottomCleanup,
      rig.bottomBlur,
      rig.bottomBoost,
      rig.bottomThreshold,
    );

    if (rig.bottomLayer.parent !== container) {
      // Place bottom layer underneath the target sprite
      const targetIndex = container.getChildIndex(sprite);
      container.addChildAt(rig.bottomLayer, targetIndex);
    }

    if (rig.maskSprite.parent) {
      rig.maskSprite.parent.removeChild(rig.maskSprite);
    }
  } else if (mode === "hard_outer") {
    // Hard outer feather layered over optional prior growth.
    rig.bottomBlur.strength = (featherAmount + growAmount) * BLUR_SCALE;
    sprite.mask = null;
    sprite.filters = [];
    container.filters = [];
    rig.bottomLayer.filters = buildFilters(
      rig.bottomCleanup,
      rig.bottomBlur,
      rig.bottomBoost,
    );

    if (rig.bottomLayer.parent !== container) {
      const targetIndex = container.getChildIndex(sprite);
      container.addChildAt(rig.bottomLayer, targetIndex);
    }

    if (rig.maskSprite.parent) {
      rig.maskSprite.parent.removeChild(rig.maskSprite);
    }
  } else if (mode === "soft_inner") {
    // Soft Inner: blur, then clamp by original alpha or an optionally grown mask.
    // This keeps all feathering constrained strictly inside the mask.
    rig.bottomBlur.strength = growAmount * BLUR_SCALE;
    rig.maskSprite.filters = hasGrow
      ? buildFilters(
          rig.softCleanup,
          rig.bottomBlur,
          rig.bottomBoost,
        )
      : buildFilters(rig.softCleanup);
    sprite.mask = rig.maskSprite;
    sprite.filters = [rig.softCleanup, rig.softBlur];
    container.filters = [];
    rig.bottomLayer.filters = [];

    if (rig.bottomLayer.parent) {
      rig.bottomLayer.parent.removeChild(rig.bottomLayer);
    }

    if (rig.maskSprite.parent !== container) {
      container.addChild(rig.maskSprite);
      rig.maskSprite.renderable = false;
    }
  } else {
    // Two-way: hard outer compositing followed by blur on this mask's local root.
    sprite.mask = null;
    sprite.filters = [];
    container.filters = [rig.twoWayBlur];
    rig.bottomBlur.strength = (featherAmount + growAmount) * BLUR_SCALE;
    rig.bottomLayer.filters = buildFilters(
      rig.bottomCleanup,
      rig.bottomBlur,
      rig.bottomBoost,
    );

    if (rig.bottomLayer.parent !== container) {
      const targetIndex = container.getChildIndex(sprite);
      container.addChildAt(rig.bottomLayer, targetIndex);
    }

    if (rig.maskSprite.parent) {
      rig.maskSprite.parent.removeChild(rig.maskSprite);
    }
  }
};
