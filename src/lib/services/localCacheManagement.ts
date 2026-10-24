import type { StorageComparison } from './storageManagement';
import type { LocalCacheContents } from './dbService';
import {
  getStorageSession,
  listLocalStorageContexts,
  forgetLocalStorageContext,
  type LocalStorageContext
} from './storageSession';
import { IndexedDbManualSyncJournal } from '../adapters/indexedDb/manualSyncJournal';
import type { PendingManualSync } from '../ports/manualSyncJournal';
import { withSyncOwnership } from './syncOwnership';
import { parseStorageCatalog } from './storageCatalog';
import { cloudRequestSignal } from '../utils/cloudRequestSignal';
import { expireSession, sessionGeneration } from '../stores/sessionState';

export interface LocalCacheInfo {
  id: string;
  label: string;
  rootPath?: string;
  status: 'active' | 'in-use' | 'reserve' | 'historical' | 'unverified';
  contents: LocalCacheContents | null;
  blockedReason: string | null;
}

export type CacheCatalog = Pick<StorageComparison, 'columns' | 'catalogError'>;

export type DeleteLocalCacheResult =
  { status: 'deleted'; warning?: string } | { status: 'blocked'; reason: string };

async function describeCache(
  local: LocalStorageContext,
  model: CacheCatalog,
  pending: PendingManualSync[]
): Promise<LocalCacheInfo> {
  const cloud = model.columns.find(
    column => column.kind === 'cloud' && column.id === local.storageId
  );
  const sameConnection = cloud?.contextId !== null && cloud?.contextId === local.contextId;
  const inUse = getStorageSession()?.descriptor?.contextId === local.contextId;
  const status: LocalCacheInfo['status'] =
    sameConnection && cloud?.active
      ? 'active'
      : inUse
        ? 'in-use'
        : model.catalogError || (cloud && cloud.contextId === null)
          ? 'unverified'
          : sameConnection
            ? 'reserve'
            : 'historical';
  let blockedReason =
    status === 'active' || inUse
      ? 'Этот кэш используется приложением. Переключите подключение и обновите вкладки.'
      : status === 'unverified'
        ? 'Подключение не проверено. Обновите версии перед удалением.'
        : null;
  const keys = [`local:${local.contextId}`, `cloud:${local.contextId}`];
  if (pending.some(operation => keys.includes(operation.targetKey)))
    blockedReason =
      'Есть неподтверждённая ручная запись. Сначала проверьте её в разделе синхронизации.';
  let contents: LocalCacheContents | null = null;
  try {
    contents = await local.database.inspectLocalCache();
  } catch {
    blockedReason = 'Не удалось прочитать кэш. Удаление недоступно до повторной проверки.';
  }
  return {
    id: local.id,
    label: local.label,
    ...(local.rootPath === undefined ? {} : { rootPath: local.rootPath }),
    status,
    contents,
    blockedReason
  };
}

export async function readLocalCaches(model: CacheCatalog): Promise<LocalCacheInfo[]> {
  const [locals, pending] = await Promise.all([
    listLocalStorageContexts(),
    new IndexedDbManualSyncJournal().list()
  ]);
  return Promise.all(locals.map(local => describeCache(local, model, pending)));
}

export async function deleteLocalCache(
  id: string,
  onblocked: () => void
): Promise<DeleteLocalCacheResult> {
  let result: DeleteLocalCacheResult = {
    status: 'blocked',
    reason: 'Синхронизация занята другой операцией. Повторите удаление позже.'
  };
  const ownership = await withSyncOwnership(async () => {
    const authentication = sessionGeneration();
    const signal = cloudRequestSignal();
    let catalog: ReturnType<typeof parseStorageCatalog> = null;
    try {
      const response = await fetch('/api/storages', { signal });
      if (response.status === 401) expireSession(authentication);
      if (response.ok) catalog = parseStorageCatalog(await response.json());
    } catch {
      /* An old comparison cannot authorize deletion of the current cache. */
    }
    if (!catalog || signal.aborted || authentication !== sessionGeneration()) {
      result = {
        status: 'blocked',
        reason: 'Не удалось проверить текущие подключения. Кэш не удалён.'
      };
      return;
    }
    const local = (await listLocalStorageContexts()).find(entry => entry.id === id);
    if (!local) {
      result = { status: 'blocked', reason: 'Кэш уже отсутствует. Обновите версии.' };
      return;
    }
    const model: CacheCatalog = {
      catalogError: null,
      columns: catalog.storages.map(entry => ({
        id: entry.id,
        label: entry.label,
        kind: 'cloud',
        contextId: entry.status === 'available' ? entry.contextId : null,
        active: entry.id === catalog.activeStorageId
      }))
    };
    const info = await describeCache(local, model, await new IndexedDbManualSyncJournal().list());
    if (info.blockedReason) {
      result = { status: 'blocked', reason: info.blockedReason };
      return;
    }
    if (signal.aborted || authentication !== sessionGeneration()) return;
    await local.database.deleteLocalCache(onblocked);
    result = { status: 'deleted' };
    try {
      await forgetLocalStorageContext(id);
    } catch {
      result = {
        status: 'deleted',
        warning: 'Данные кэша удалены, но не удалось убрать его из списка. Обновите страницу.'
      };
    }
  });
  if (ownership === null)
    return {
      status: 'blocked',
      reason: 'Для безопасного удаления нужен браузер с поддержкой Web Locks.'
    };
  return result;
}
