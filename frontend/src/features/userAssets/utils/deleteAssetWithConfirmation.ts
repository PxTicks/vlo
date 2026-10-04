interface DeleteAssetWithConfirmationOptions {
  assetId: string;
  deleteAsset: (assetId: string) => Promise<void> | void;
  timelineClipCount: number;
}

interface DeleteAssetBatchWithConfirmationOptions {
  assetIds: readonly string[];
  deleteAsset: (assetId: string) => Promise<void> | void;
  timelineClipCount: number;
}

export function getAssetDeleteConfirmationMessage(
  timelineClipCount: number,
): string {
  return timelineClipCount > 0
    ? "Are you sure you want to delete this asset? This will remove it from disk permanently.\n\nThis asset is used by clips on the Timeline.\nClips on the Timeline are derived from the asset and will be deleted."
    : "Are you sure you want to delete this asset? This will remove it from disk permanently.";
}

export async function deleteAssetWithConfirmation({
  assetId,
  deleteAsset,
  timelineClipCount,
}: DeleteAssetWithConfirmationOptions): Promise<boolean> {
  const confirmMessage = getAssetDeleteConfirmationMessage(timelineClipCount);

  if (!window.confirm(confirmMessage)) {
    return false;
  }

  await deleteAsset(assetId);
  return true;
}

export function getAssetBatchDeleteConfirmationMessage(
  timelineClipCount: number,
): string {
  return timelineClipCount > 0
    ? "Are you sure you want to delete this entire asset batch? This will remove all assets in this batch from disk permanently.\n\nSome assets in this batch are used by clips on the Timeline.\nClips on the Timeline derived from this batch will be deleted."
    : "Are you sure you want to delete this entire asset batch? This will remove all assets in this batch from disk permanently.";
}

export async function deleteAssetBatchWithConfirmation({
  assetIds,
  deleteAsset,
  timelineClipCount,
}: DeleteAssetBatchWithConfirmationOptions): Promise<boolean> {
  if (assetIds.length === 0) {
    return false;
  }

  const confirmMessage =
    getAssetBatchDeleteConfirmationMessage(timelineClipCount);

  if (!window.confirm(confirmMessage)) {
    return false;
  }

  for (const assetId of assetIds) {
    await deleteAsset(assetId);
  }

  return true;
}
