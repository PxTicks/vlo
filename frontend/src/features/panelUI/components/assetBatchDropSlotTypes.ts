import type { Asset, AssetType } from "../../../types/Asset";
import type { AssetDropSlotValue } from "./assetDropSlotTypes";

/**
 * Per-item switches an occupied position can carry. Kept as an open,
 * icon-driven list rather than a fixed field so image/video/audio batches share
 * one item shape: video items surface `audio`, the others surface nothing, and
 * a future per-item option only needs a new icon.
 */
export type AssetBatchSlotOptionIcon = "audio";

export interface AssetBatchSlotOption {
  /** Stable within an item; echoed back by `onToggleOption`. */
  id: string;
  icon: AssetBatchSlotOptionIcon;
  active: boolean;
  /** Tooltip while inactive — phrase it as what toggling on will do. */
  label: string;
  /** Tooltip while active. Falls back to `label`. */
  activeLabel?: string;
}

/** One occupied position in the strip, in delivery order. */
export interface AssetBatchSlotItem {
  /**
   * Identifies the position to every callback. Callers that back the strip
   * with individually addressable slots (the generation panel's repeatable
   * inputs) pass the slot id, so nothing else has to translate indices.
   */
  slotId: string;
  value: AssetDropSlotValue;
  /** Enables the pencil affordance (e.g. a video's frame-extraction editor). */
  editable?: boolean;
  options?: readonly AssetBatchSlotOption[];
}

/**
 * A batch input rendered as one telescoping slot: it grows as items are added,
 * wraps to the panel width, and shows a trailing `+` until it is full.
 *
 * Every affordance of a single {@link AssetDropSlot} is preserved per item —
 * library drop, external file drop, click-to-select, clear, edit — with drag
 * reordering and per-item options layered on top.
 */
export interface AssetBatchDropSlotProps {
  /** Unique identifier for the strip; item ids come from the items. */
  id: string;
  /** Which asset types every position accepts. */
  accept: AssetType[];
  /**
   * Additional per-asset allowance checked when the asset's own type is not in
   * `accept` (a video dropped on an audio batch, say). Library assets only.
   */
  acceptAsset?: (asset: Asset) => boolean;
  /** Asset types accepted from an external file drop. Defaults to `accept`. */
  acceptExternal?: AssetType[];
  /** Occupied positions, in the order the nodes will receive them. */
  items: readonly AssetBatchSlotItem[];
  /** Hard ceiling on positions; the `+` hides once `items` reaches it. */
  max: number;
  /** Label for the position at `index`, used as the tile's caption. */
  itemLabel?: (index: number) => string;
  /** A compatible library asset was dropped on the position at `index`. */
  onDrop?: (index: number, asset: Asset) => void;
  /** A compatible external file was dropped on the position at `index`. */
  onExternalDrop?: (index: number, file: File) => void | Promise<void>;
  /** The position at `index` was clicked (timeline selection flow). */
  onSelect?: (index: number) => void;
  onClear?: (slotId: string) => void;
  onEdit?: (slotId: string) => void;
  /**
   * An item was dragged onto another position. `toIndex` is where it should
   * come to rest; the remaining items close up around it.
   */
  onReorder?: (slotId: string, toIndex: number) => void;
  onToggleOption?: (
    slotId: string,
    optionId: string,
    nextActive: boolean,
  ) => void;
}
