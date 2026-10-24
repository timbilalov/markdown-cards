import type { StorageComparison } from './storageManagement';
import {
  noteStorageTargetKey,
  planNoteSync,
  type NoteSyncPlan,
  type NoteSyncSelection
} from '../domain/storageSync';
import { executeNoteSync, type NoteSyncResult } from '../application/executeNoteSync';
import type { ManualSyncOperation, PendingManualSync } from '../ports/manualSyncJournal';
import type { ManualSyncArchive } from '../ports/manualLocalStorage';
import { IndexedDbManualSyncJournal } from '../adapters/indexedDb/manualSyncJournal';
import { listLocalStorageContexts } from './storageSession';
import { createContextDatabase } from './localStorageContexts';
import { withSyncOwnership } from './syncOwnership';

export interface ManualSyncState {
  pending: PendingManualSync[];
  archives: (ManualSyncArchive & { storageLabel: string })[];
  history: ManualSyncOperation[];
}

const journal = new IndexedDbManualSyncJournal();

export interface PreparedStorageSync extends NoteSyncPlan {
  storageContexts: Record<string, string>;
}

export function prepareStorageSync(
  model: StorageComparison,
  selection: NoteSyncSelection
): PreparedStorageSync {
  const plan = planNoteSync(model.snapshots, selection);
  return {
    ...plan,
    storageContexts: Object.fromEntries(
      [...new Set([selection.sourceStorageId, ...selection.targetStorageIds])].flatMap(id => {
        const storage = model.storages.get(id);
        return storage ? [[id, noteStorageTargetKey(storage)]] : [];
      })
    )
  };
}

export function runStorageSync(
  model: StorageComparison,
  plan: PreparedStorageSync
): Promise<NoteSyncResult[]> {
  const guarded = {
    actions: plan.actions.map(action => {
      if (action.status === 'blocked') return action;
      const changed = [action.sourceStorageId, action.targetStorageId].some(id => {
        const storage = model.storages.get(id);
        return storage && plan.storageContexts[id] !== noteStorageTargetKey(storage);
      });
      return changed
        ? { ...action, status: 'blocked' as const, reason: 'context-changed' as const }
        : action;
    })
  };
  return executeNoteSync(guarded, {
    storages: model.storages,
    journal,
    exclusive: withSyncOwnership,
    newId: () => crypto.randomUUID(),
    now: () => Date.now()
  });
}

export async function readManualSyncState(): Promise<ManualSyncState> {
  const pending = await journal.list();
  const history = await journal.history();
  const archives = (
    await Promise.all(
      (await listLocalStorageContexts()).map(async local =>
        (await (await local.database.getManualSyncRepository()).archives()).map(row => ({
          ...row,
          storageLabel: local.label
        }))
      )
    )
  ).flat();
  return { pending, archives, history };
}

async function recover(
  model: StorageComparison,
  input: ManualSyncOperation,
  dismiss: boolean
): Promise<'confirmed' | 'different' | 'unavailable'> {
  const captured = structuredClone(input);
  const storages = new Map(model.storages);
  let result: 'confirmed' | 'different' | 'unavailable' = 'unavailable';
  try {
    await withSyncOwnership(async () => {
      // Persisted intent is authoritative; stale UI data grants no new permission.
      const operation = (await journal.list()).find(
        row =>
          row.id === captured.id &&
          row.targetKey === captured.targetKey &&
          row.pathKey === captured.pathKey
      );
      if (!operation) return;
      const target = storages.get(operation.targetStorageId);
      if (!target || noteStorageTargetKey(target) !== operation.targetKey) return;
      if (!dismiss) {
        const read = await target.read(operation.path);
        if (read.status === 'unavailable' || read.status === 'invalid') return;
        if (
          read.status !== 'found' ||
          read.document.path !== operation.path ||
          read.document.source !== operation.source
        ) {
          result = 'different';
          return;
        }
      }
      if (target.kind === 'cloud' && target.contextId) {
        const local = await createContextDatabase(target.contextId).getManualSyncRepository();
        if (dismiss) await local.protect(operation.path);
        else await local.finishCloud(operation.path, operation.source);
      }
      if (dismiss) await journal.dismiss(operation);
      else await journal.settle(operation, 'known');
      result = 'confirmed';
    });
  } catch {
    return 'unavailable';
  }
  return result;
}

export function verifyManualSync(
  model: StorageComparison,
  operation: ManualSyncOperation
): Promise<'confirmed' | 'different' | 'unavailable'> {
  return recover(model, operation, false);
}

export async function dismissManualSync(
  model: StorageComparison,
  operation: ManualSyncOperation
): Promise<boolean> {
  return (await recover(model, operation, true)) === 'confirmed';
}
