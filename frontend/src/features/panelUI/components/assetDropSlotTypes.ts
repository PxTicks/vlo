import type { Asset, AssetType } from "../../../types/Asset";

export interface AssetDropSlotValue {
  type: AssetType;
  name: string;
  thumbnail?: string;
}

export interface AssetDropSlotReorderData {
  type: "media-input";
  inputId: string;
}

export interface AssetDropSlotProps {
  /** Unique identifier for this slot */
  id: string;
  /** Which asset types this slot accepts */
  accept: AssetType[];
  /** Currently assigned asset */
  value?: AssetDropSlotValue | null;
  /** Callback to clear the assigned asset */
  onClear?: () => void;
  /** Called when a compatible asset is dropped on this slot */
  onDrop?: (asset: Asset) => void;
  /** Called when a compatible external file is dropped on this slot */
  onExternalDrop?: (file: File) => void | Promise<void>;
  /** Called when the slot is clicked to select from timeline */
  onSelect?: () => void;
  /** Label shown above the slot */
  label?: string;
  /** Makes a filled slot draggable for media-input reordering */
  reorderData?: AssetDropSlotReorderData | null;
  /** Called when a media-input slot is dropped onto this slot */
  onReorderDrop?: (data: AssetDropSlotReorderData) => void;
}
