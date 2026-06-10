import type { PersistedAssetIndexEntry } from "../../project/services/ProjectPersistenceService";
import {
  PROJECT_TRASH_LIMIT_BYTES,
  projectTrashService,
  type ProjectTrashItem,
} from "../../project/services/ProjectTrashService";

interface DeferredAssetCleanupRecord {
  assetId: string;
  entry: PersistedAssetIndexEntry;
  trashItem: ProjectTrashItem;
  createdAt: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class DeferredAssetCleanupService {
  private recordsByAssetId = new Map<string, DeferredAssetCleanupRecord>();
  private operationQueues = new Map<string, Promise<unknown>>();

  private async enqueueAssetOperation<T>(
    assetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operationQueues.get(assetId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const queued = run.then(
      () => undefined,
      () => undefined,
    );
    this.operationQueues.set(assetId, queued);

    try {
      return await run;
    } finally {
      if (this.operationQueues.get(assetId) === queued) {
        this.operationQueues.delete(assetId);
      }
    }
  }

  async deferAssetCleanup(
    entry: PersistedAssetIndexEntry,
    paths: Iterable<string>,
  ): Promise<void> {
    await this.enqueueAssetOperation(entry.id, async () => {
      const existing = this.recordsByAssetId.get(entry.id);
      if (existing) {
        await projectTrashService.deleteTrashItem(existing.trashItem);
        this.recordsByAssetId.delete(entry.id);
      }

      const trashItem = await projectTrashService.moveFilesToTrash(paths);
      this.recordsByAssetId.set(entry.id, {
        assetId: entry.id,
        entry: clone(entry),
        trashItem,
        createdAt: Date.now(),
      });
      await this.enforceTrashLimit();
    });
  }

  async restoreAssetCleanup(
    assetId: string,
  ): Promise<PersistedAssetIndexEntry | null> {
    return this.enqueueAssetOperation(assetId, async () => {
      const record = this.recordsByAssetId.get(assetId);
      if (!record) {
        return null;
      }

      await projectTrashService.restoreTrashItem(record.trashItem);
      this.recordsByAssetId.delete(assetId);
      return clone(record.entry);
    });
  }

  async clearTrash(): Promise<void> {
    await Promise.allSettled([...this.operationQueues.values()]);
    this.recordsByAssetId.clear();
    this.operationQueues.clear();
    await projectTrashService.clearTrash();
  }

  reset(): void {
    this.recordsByAssetId.clear();
    this.operationQueues.clear();
  }

  private async enforceTrashLimit(): Promise<void> {
    let totalBytes = [...this.recordsByAssetId.values()].reduce(
      (total, record) => total + record.trashItem.sizeBytes,
      0,
    );

    if (totalBytes <= PROJECT_TRASH_LIMIT_BYTES) {
      return;
    }

    const oldestFirst = [...this.recordsByAssetId.values()].sort(
      (left, right) => left.createdAt - right.createdAt,
    );

    for (const record of oldestFirst) {
      if (totalBytes <= PROJECT_TRASH_LIMIT_BYTES) {
        break;
      }

      await projectTrashService.deleteTrashItem(record.trashItem);
      this.recordsByAssetId.delete(record.assetId);
      totalBytes -= record.trashItem.sizeBytes;
    }
  }
}

export const deferredAssetCleanupService =
  new DeferredAssetCleanupService();
