import { AlphaMask, type Container, type Sprite } from "pixi.js";

export type MaskApplicationMode = "none" | "regular" | "alpha";

export class MaskApplicationController {
  private readonly maskTarget: Container;
  private readonly maskContainer: Container;
  private readonly maskSprite: Sprite | null;
  private readonly hasUsableTexture: (sprite: Sprite) => boolean;

  private alphaMaskEffect: AlphaMask | null = null;
  private currentMaskMode: MaskApplicationMode = "none";
  private currentInverse = false;
  private currentMaskSignature = "";

  constructor(
    maskTarget: Container,
    maskContainer: Container,
    maskSprite: Sprite | null,
    hasUsableTexture: (sprite: Sprite) => boolean,
  ) {
    this.maskTarget = maskTarget;
    this.maskContainer = maskContainer;
    this.maskSprite = maskSprite;
    this.hasUsableTexture = hasUsableTexture;
  }

  public getCurrentMaskMode(): MaskApplicationMode {
    return this.currentMaskMode;
  }

  public getCurrentInverse(): boolean {
    return this.currentInverse;
  }

  public getCurrentMaskSignature(): string {
    return this.currentMaskSignature;
  }

  public applyAlphaMask(target: Sprite, inverse: boolean, signature = ""): void {
    const previousMode = this.currentMaskMode;

    if (previousMode === "regular") {
      this.setMaskOnTarget(null, false);
    }

    const targetChanged =
      this.alphaMaskEffect && this.alphaMaskEffect.mask !== target;

    if (
      this.currentMaskMode !== "alpha" ||
      this.currentInverse !== inverse ||
      targetChanged ||
      this.currentMaskSignature !== signature
    ) {
      if (previousMode === "alpha") {
        this.detachAlphaMaskEffect();
      }

      if (!this.alphaMaskEffect || this.alphaMaskEffect.mask !== target) {
        this.alphaMaskEffect?.destroy();
        this.alphaMaskEffect = new AlphaMask({ mask: target });
      }

      this.alphaMaskEffect.inverse = inverse;
      this.attachAlphaMaskEffect();
      this.currentMaskMode = "alpha";
      this.currentInverse = inverse;
      this.currentMaskSignature = signature;
    }

    this.syncOutputModeVisibility();
  }

  public applyMaskEffect(
    mask: Container | null,
    inverse: boolean,
    useAlphaMask: boolean,
    signature = "",
  ): void {
    const previousMode = this.currentMaskMode;
    const nextMode: MaskApplicationMode =
      mask === null ? "none" : useAlphaMask ? "alpha" : "regular";

    if (
      this.currentMaskMode === nextMode &&
      this.currentInverse === inverse &&
      this.currentMaskSignature === signature
    ) {
      return;
    }

    if (previousMode === "alpha") {
      this.detachAlphaMaskEffect();
    }

    this.currentMaskMode = nextMode;
    this.currentInverse = inverse;
    this.currentMaskSignature = signature;

    if (!mask) {
      this.clear();
      return;
    }

    if (nextMode === "regular") {
      this.syncOutputModeVisibility();
      this.setMaskOnTarget(mask, inverse);
      return;
    }

    if (nextMode === "alpha") {
      if (previousMode === "regular") {
        this.setMaskOnTarget(null, false);
      }

      if (!this.alphaMaskEffect || this.alphaMaskEffect.mask !== mask) {
        this.alphaMaskEffect?.destroy();
        this.alphaMaskEffect = new AlphaMask({ mask });
      }
      this.alphaMaskEffect.inverse = inverse;
      this.attachAlphaMaskEffect();
      this.syncOutputModeVisibility();
    }
  }

  public clear(): void {
    this.currentMaskMode = "none";
    this.currentInverse = false;
    this.currentMaskSignature = "";
    this.detachAlphaMaskEffect();
    this.setMaskOnTarget(null, false);
    this.syncOutputModeVisibility();
  }

  public dispose(): void {
    this.clear();
    this.alphaMaskEffect?.destroy();
    this.alphaMaskEffect = null;
  }

  public syncOutputModeVisibility(): void {
    this.maskContainer.visible = this.currentMaskMode === "regular";

    if (!this.maskSprite) {
      return;
    }

    const hasMaskTexture = this.hasUsableTexture(this.maskSprite);
    const shouldKeepMaskSpriteActive =
      this.currentMaskMode === "alpha" && hasMaskTexture;

    this.maskSprite.visible = shouldKeepMaskSpriteActive;
    this.maskSprite.renderable = false;
  }

  private attachAlphaMaskEffect(): void {
    if (!this.alphaMaskEffect) {
      return;
    }
    if (typeof this.maskTarget.addEffect !== "function") {
      return;
    }
    const effects = this.maskTarget.effects ?? [];
    if (!effects.includes(this.alphaMaskEffect)) {
      this.maskTarget.addEffect(this.alphaMaskEffect);
    }
  }

  private detachAlphaMaskEffect(): void {
    if (!this.alphaMaskEffect) {
      return;
    }
    if (typeof this.maskTarget.removeEffect !== "function") {
      return;
    }
    const effects = this.maskTarget.effects ?? [];
    if (effects.includes(this.alphaMaskEffect)) {
      this.maskTarget.removeEffect(this.alphaMaskEffect);
    }
  }

  private setMaskOnTarget(mask: Container | null, inverse: boolean): void {
    if (typeof this.maskTarget.setMask === "function") {
      this.maskTarget.setMask({ mask, inverse });
      return;
    }
    this.maskTarget.mask = mask;
  }
}
