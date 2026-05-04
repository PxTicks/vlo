import { Container, Graphics, RenderTexture, Sprite, Texture } from "pixi.js";
import { AssetMaskSourceFactory } from "./AssetMaskSourceFactory";
import type {
  AssetMaskNode,
  AssetMaskNodeEntry,
  VectorMaskNode,
} from "./MaskSceneNodes";

function createVectorMaskSpriteHost(
  texture: RenderTexture | null,
): Pick<VectorMaskNode, "spriteHost" | "sprite"> {
  const spriteHost = new Container();
  const sprite = new Sprite(texture ?? Texture.EMPTY);
  sprite.anchor.set(0.5);
  sprite.visible = false;
  spriteHost.visible = false;
  spriteHost.addChild(sprite);

  return { spriteHost, sprite };
}

export class MaskSceneNodeRegistry {
  public readonly vectorMaskNodes = new Map<string, VectorMaskNode>();
  public readonly assetMaskNodes = new Map<string, AssetMaskNode>();

  private readonly maskContainer: Container;
  private readonly assetMaskSourceFactory: AssetMaskSourceFactory;
  private readonly hasUsableTexture: (sprite: Sprite) => boolean;

  constructor(
    maskContainer: Container,
    assetMaskSourceFactory: AssetMaskSourceFactory,
    hasUsableTexture: (sprite: Sprite) => boolean,
  ) {
    this.maskContainer = maskContainer;
    this.assetMaskSourceFactory = assetMaskSourceFactory;
    this.hasUsableTexture = hasUsableTexture;
  }

  public getMaskContainer(): Container {
    return this.maskContainer;
  }

  public getVectorNode(maskClipId: string): VectorMaskNode | null {
    return this.vectorMaskNodes.get(maskClipId) ?? null;
  }

  public getAssetNode(maskClipId: string): AssetMaskNode | null {
    return this.assetMaskNodes.get(maskClipId) ?? null;
  }

  public reconcileVectorNodes(maskIds: string[]): void {
    const wanted = new Set(maskIds);
    this.vectorMaskNodes.forEach((node, maskId) => {
      if (wanted.has(maskId)) {
        return;
      }

      if (node.rasterTexture) {
        node.rasterTexture.destroy(true);
        node.rasterTexture = null;
      }
      if (node.root.parent) {
        node.root.removeFromParent();
      }
      if (!node.root.destroyed) {
        node.root.destroy({ children: true });
      }
      this.vectorMaskNodes.delete(maskId);
    });

    maskIds.forEach((maskId) => {
      if (this.vectorMaskNodes.has(maskId)) {
        return;
      }

      const root = new Container();
      const graphics = new Graphics();
      const { spriteHost, sprite } = createVectorMaskSpriteHost(null);
      root.addChild(graphics);
      root.addChild(spriteHost);
      this.maskContainer.addChild(root);
      this.vectorMaskNodes.set(maskId, {
        root,
        graphics,
        spriteHost,
        sprite,
        shapeSignature: "",
        rasterSignature: "",
        rasterTexture: null,
        rasterWidth: 0,
        rasterHeight: 0,
        presentation: "graphics",
      });
    });
  }

  public reconcileAssetMaskNodes(entries: AssetMaskNodeEntry[]): void {
    const wantedMaskIds = new Set(entries.map((entry) => entry.maskId));
    this.assetMaskNodes.forEach((node, maskId) => {
      if (wantedMaskIds.has(maskId)) {
        return;
      }

      this.disposeAssetNode(maskId, node);
    });

    entries.forEach((entry) => {
      const existing = this.assetMaskNodes.get(entry.maskId);
      if (existing) {
        if (existing.kind === entry.kind) {
          return;
        }
        this.disposeAssetNode(entry.maskId, existing);
      }

      const root = new Container();
      const { player, thresholdFilter } =
        this.assetMaskSourceFactory.createMaskSource(entry);
      root.addChild(player.sprite);
      this.maskContainer.addChild(root);
      this.assetMaskNodes.set(entry.maskId, {
        root,
        player,
        assetId: entry.assetId,
        thresholdFilter,
        kind: entry.kind,
      });
    });
  }

  public clearVisibility(): void {
    this.vectorMaskNodes.forEach((node) => {
      node.root.visible = false;
      node.sprite.visible = false;
      node.spriteHost.visible = false;
    });
    this.assetMaskNodes.forEach((node) => {
      node.root.visible = false;
      node.player.sprite.visible = false;
    });
  }

  public sanitizeAssetMaskSpriteVisibility(): void {
    this.assetMaskNodes.forEach((node) => {
      if (node.player.sprite.visible && !this.hasUsableTexture(node.player.sprite)) {
        node.player.sprite.visible = false;
      }
    });
  }

  public ensureVectorMaskRenderTexture(
    node: VectorMaskNode,
    contentSize: { width: number; height: number },
  ): boolean {
    const { width, height } = contentSize;
    let textureChanged = false;

    if (!node.rasterTexture) {
      node.rasterTexture = RenderTexture.create({
        width,
        height,
        dynamic: true,
      });
      textureChanged = true;
    } else if (node.rasterWidth !== width || node.rasterHeight !== height) {
      node.rasterTexture.resize(width, height);
      textureChanged = true;
    }

    node.rasterWidth = width;
    node.rasterHeight = height;
    return textureChanged;
  }

  public dispose(): void {
    this.vectorMaskNodes.forEach((node, maskId) => {
      if (node.rasterTexture) {
        node.rasterTexture.destroy(true);
        node.rasterTexture = null;
      }
      if (node.root.parent) {
        node.root.removeFromParent();
      }
      if (!node.root.destroyed) {
        node.root.destroy({ children: true });
      }
      this.vectorMaskNodes.delete(maskId);
    });

    this.assetMaskNodes.forEach((node, maskId) => {
      this.disposeAssetNode(maskId, node);
    });
  }

  private disposeAssetNode(maskId: string, node: AssetMaskNode): void {
    if (node.root.parent) {
      node.root.removeFromParent();
    }
    this.assetMaskSourceFactory.disposeMaskNode(node);
    if (!node.root.destroyed) {
      node.root.destroy({ children: false });
    }
    this.assetMaskNodes.delete(maskId);
  }
}
