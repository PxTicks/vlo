import { Container } from "pixi.js";
import type {
  ExtensionSpatialPathOverlayContext,
  ExtensionSpatialPathOverlayParameters,
  ExtensionSpatialPathParameter,
} from "../../extensions/types";
import {
  TrustedHostObjectManager,
  type TrustedHostObjectSlotAdapter,
} from "../../extensions/runtime/publicApi";
import { extensionSpatialPathRegistry } from "./ExtensionAnimationRegistry";

const OVERLAY_SLOT_ADAPTER: TrustedHostObjectSlotAdapter<
  Container,
  Container,
  undefined
> = {
  slotKind: "Pixi spatial-path overlay",
  validate: (object): object is Container => object instanceof Container,
  isSameSlot: (left, right) => left === right,
  attach: (object, slot) => {
    if (object.parent !== slot) slot.addChild(object);
  },
  detach: (object, slot) => {
    if (object.parent === slot) slot.removeChild(object);
  },
  destroy: (object) => {
    if (!object.destroyed) object.destroy({ children: true });
  },
};

/** Host-owned adapter for arbitrary trusted Pixi path handles and overlays. */
export class TrustedSpatialPathOverlayRenderer {
  private manager: TrustedHostObjectManager<
    Container,
    ExtensionSpatialPathOverlayParameters,
    ExtensionSpatialPathOverlayContext,
    Container,
    undefined
  > | null = null;
  private object: Container | null = null;
  private contributionId: string | null = null;
  private readonly reported = new Set<string>();

  update(
    path: ExtensionSpatialPathParameter,
    currentTime: number,
    duration: number,
    slot: Container,
    context: ExtensionSpatialPathOverlayContext,
  ): boolean {
    const contribution = extensionSpatialPathRegistry.get(path.geometry);
    if (!contribution?.definition.createOverlay) {
      this.clear();
      return false;
    }
    if (this.contributionId !== contribution.id) {
      this.clear();
      const contributionId = contribution.id;
      this.manager = new TrustedHostObjectManager({
        contributionId,
        create: contribution.definition.createOverlay,
        adapter: OVERLAY_SLOT_ADAPTER,
        reportFailureOnce: (key, level, message, detail) => {
          const reportKey = `${contributionId}:${key}`;
          if (this.reported.has(reportKey)) return;
          this.reported.add(reportKey);
          contribution.definition.report(level, message, detail);
        },
      });
      this.object = this.manager.create();
      this.contributionId = contribution.id;
    }
    if (!this.manager || !this.object) return false;
    return this.manager.update(
      this.object,
      { value: path, currentTime, duration, selected: true },
      context,
      slot,
      undefined,
    );
  }

  clear(): void {
    this.manager?.dispose();
    this.manager = null;
    this.object = null;
    this.contributionId = null;
  }

  dispose(): void {
    this.clear();
    this.reported.clear();
  }
}
