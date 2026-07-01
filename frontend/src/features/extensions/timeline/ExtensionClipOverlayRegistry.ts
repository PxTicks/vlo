import type { ReactNode } from "react";
import type {
  ExtensionApiScope,
  ExtensionClipOverlayDefinition,
  ExtensionClipOverlayDragContext,
  ExtensionClipOverlayItem,
  ExtensionClipOverlayRegistration,
} from "../types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "../registry/ExtensionContributionRegistry";
import { toExtensionClipSnapshot } from "../../timeline/api";
import type {
  TimelineClipOverlayDefinition,
  TimelineClipOverlayDragContext,
  TimelineClipOverlayItem,
  TimelineClipOverlayPlacement,
} from "../../timeline/clipOverlayApi";

export interface RuntimeClipOverlayDefinition
  extends ExtensionContributionDefinition {
  readonly kind: "trusted-overlay";
  /** Host-native overlay definition adapted from the extension contribution. */
  readonly overlay: TimelineClipOverlayDefinition;
  readonly report: ExtensionApiScope["report"];
}

export type RegisteredExtensionClipOverlay =
  RegisteredExtensionContribution<RuntimeClipOverlayDefinition>;

function compileOverlay(
  ownerId: string,
  definition: ExtensionClipOverlayDefinition,
  report: ExtensionApiScope["report"],
): RuntimeClipOverlayDefinition {
  if (definition.apiVersion !== 1 || definition.kind !== "trusted-overlay") {
    throw new Error(
      `Clip overlay '${definition.id}' must use trusted-overlay API 1.`,
    );
  }
  if (typeof definition.useItems !== "function") {
    throw new TypeError(
      `Clip overlay '${definition.id}' must define a useItems() hook.`,
    );
  }

  const contributionId = `${ownerId}/${definition.id}`;
  let useItemsFailureReported = false;

  const adaptItem = (item: ExtensionClipOverlayItem): TimelineClipOverlayItem => {
    const runHandler = (label: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        report(
          "error",
          `Clip overlay '${contributionId}' ${label} handler failed.`,
          error,
        );
      }
    };
    const toDragContext = (
      context: TimelineClipOverlayDragContext,
    ): ExtensionClipOverlayDragContext => ({
      ...context,
      clip: toExtensionClipSnapshot(context.clip),
      item,
    });

    return {
      id: item.id,
      content: item.content as ReactNode,
      visibility: item.visibility ?? "always",
      placement: item.placement as TimelineClipOverlayPlacement,
      minClipWidthPx: item.minClipWidthPx,
      onClick: item.onClick
        ? () => runHandler("onClick", () => item.onClick?.())
        : undefined,
      onContextMenu: item.onContextMenu
        ? (event) => runHandler("onContextMenu", () => item.onContextMenu?.(event))
        : undefined,
      drag: item.drag
        ? {
            onDragStart: item.drag.onDragStart
              ? (context) =>
                  runHandler("onDragStart", () =>
                    item.drag?.onDragStart?.(toDragContext(context)),
                  )
              : undefined,
            onDrag: item.drag.onDrag
              ? (context) =>
                  runHandler("onDrag", () =>
                    item.drag?.onDrag?.(toDragContext(context)),
                  )
              : undefined,
            onDragEnd: item.drag.onDragEnd
              ? (context) =>
                  runHandler("onDragEnd", () =>
                    item.drag?.onDragEnd?.(toDragContext(context)),
                  )
              : undefined,
          }
        : undefined,
    };
  };

  const overlay: TimelineClipOverlayDefinition = {
    id: contributionId,
    useItems: ({ clip, isSelected }) => {
      let items: readonly ExtensionClipOverlayItem[];
      try {
        items = definition.useItems({
          clip: toExtensionClipSnapshot(clip),
          isSelected,
        });
      } catch (error) {
        if (!useItemsFailureReported) {
          useItemsFailureReported = true;
          report(
            "error",
            `Clip overlay '${contributionId}' useItems() threw; its items were dropped.`,
            error,
          );
        }
        return [];
      }
      return items.map(adaptItem);
    },
  };

  return Object.freeze({
    id: definition.id,
    apiVersion: 1,
    kind: "trusted-overlay",
    execution: "trusted" as const,
    overlay,
    report,
  });
}

export class ExtensionClipOverlayRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<RuntimeClipOverlayDefinition>(
      "clip-overlay",
    );

  bind(scope: ExtensionApiScope): {
    register(
      definition: ExtensionClipOverlayDefinition,
    ): ExtensionClipOverlayRegistration;
  } {
    const bound = this.registry.bind(scope);
    return Object.freeze({
      register: (
        definition: ExtensionClipOverlayDefinition,
      ): ExtensionClipOverlayRegistration => {
        const registration = bound.register(
          compileOverlay(scope.extension.id, definition, scope.report),
        );
        return Object.freeze({
          id: registration.id,
          dispose: registration.dispose,
        });
      },
    });
  }

  list(): readonly RegisteredExtensionClipOverlay[] {
    return this.registry.list();
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }
}

export const extensionClipOverlayRegistry = new ExtensionClipOverlayRegistry();
