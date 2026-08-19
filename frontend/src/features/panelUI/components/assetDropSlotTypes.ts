import type { Asset, AssetType } from "../../../types/Asset";

export interface AssetDropSlotValue {
  type: AssetType;
  name: string;
  thumbnail?: string;
  /**
   * Set while the slot's value is still being prepared (for example extracting
   * the audio track out of a dropped video) or when that preparation failed.
   */
  status?: "preparing" | "error";
  /** Shown in place of the name when `status` is set. */
  statusMessage?: string;
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
  /**
   * Additional per-asset allowance, checked when the asset's own type is not in
   * `accept` (for example a video carrying an audio track dropped on an audio
   * slot). Applies to library assets only; external file drops go by
   * `acceptExternal`.
   */
  acceptAsset?: (asset: Asset) => boolean;
  /**
   * Asset types accepted from an external (operating-system) file drop.
   * Defaults to `accept`. Widen it where a file's suitability can only be
   * judged after ingest — an audio slot takes video files, whose audio track
   * is extracted once the file is in the library.
   */
  acceptExternal?: AssetType[];
  /** Currently assigned asset */
  value?: AssetDropSlotValue | null;
  /** Callback to clear the assigned asset */
  onClear?: () => void;
  /** When provided and the slot is filled, shows a pencil button to edit the value. */
  onEdit?: () => void;
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
