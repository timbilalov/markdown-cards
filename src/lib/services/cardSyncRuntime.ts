import { withSyncOwnership } from './syncOwnership';
import { CardSync, type SyncStatus } from '../application/cardSync';
import { BrowserCloudStorage } from '../adapters/browserCloudStorage';
import { dbService } from './dbService';
import { sessionDeliverySignal } from '../stores/sessionState';

import { IndexedDbManualSyncJournal } from '../adapters/indexedDb/manualSyncJournal';
import { getStorageSession } from './storageSession';
let workerChannel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();
export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function notify(): void {
  for (const listener of listeners) {
    try { void Promise.resolve(listener()).catch(error => console.warn('Sync observer failed', error)); }
    catch (error) { console.warn('Sync observer failed', error); }
  }
}

export async function getCardSync(): Promise<CardSync> {
  const session = getStorageSession();
  const database = dbService;
  const cloud = new BrowserCloudStorage(session?.descriptor ?? undefined);
  const deliverySignal = session ? AbortSignal.any([sessionDeliverySignal(), session.deliverySignal]) : sessionDeliverySignal();
  // Repositories borrow the current connection; do not retain one across a
  // versionchange/close while DBService is able to reopen it.
  return database.getSyncRepositories().then(repositories => new CardSync({
    ...repositories, cloud, deliverySignal,
    checkIsDeliveryBlocked: async path => {
      if (!session?.descriptor) return false;
      const key = `cloud:${session.descriptor.contextId}`;
      const canonical = session.descriptor.capabilities.caseSensitivePaths === false ? path.toLowerCase() : path;
      return (await new IndexedDbManualSyncJournal().list()).some(row => row.targetKey === key && row.pathKey === canonical);
    }, readListed: (path, signal) => cloud.readListed(path, signal),
    onChange: () => { notify(); workerChannel?.postMessage('changed'); },
    readCards: () => database.getAllCards(),
    readSource: async filename => {
      const cached = await database.getMarkdownDocument(filename);
      return cached?.result.status === 'success' ? cached.result.document.source : cached?.result.source ?? null;
    },
    refresh: input => database.refreshMarkdownCache(input),
    now: () => Date.now(), newId: () => crypto.randomUUID(), checkIsOnline: () => navigator.onLine,
    exclusive: withSyncOwnership
  }));
}

export async function retryCardSync(manual = false, signal?: AbortSignal): Promise<SyncStatus> {
  try { return await (await getCardSync()).retry(manual, signal); }
  catch { return 'storage-error'; }
}

// A worker belongs to the mounted app, not to an editor or an import side effect.
// Web Locks include recovery, preflight, upload and acknowledgement across tabs.
export function startCardSyncWorker(): () => void {
  let stopped = false;
  let running = false;
  const controller = new AbortController();
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('markdown-cards-sync');
  workerChannel = channel;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try { await retryCardSync(false, controller.signal); }
    finally { running = false; }
  };
  if (channel) channel.onmessage = () => { if (!stopped) notify(); };
  window.addEventListener('online', run);
  const timer = setInterval(run, 1000);
  run();
  return () => {
    stopped = true; controller.abort(); clearInterval(timer); window.removeEventListener('online', run); channel?.close();
    if (workerChannel === channel) workerChannel = null;
  };
}

export function describeSyncStatus(status: SyncStatus): string {
  const label=getStorageSession()?.descriptor?.label??'Яндекс Диск';
  switch (status) {
    case 'superseded': return 'Эту версию заменила другая локальная версия. Её запись в облако не подтверждена.';
    case 'synced': return `Сохранено в хранилище «${label}».`;
    case 'pending': case 'offline': return 'Сохранено локально, ожидает синхронизации.';
    case 'unauthorized': return 'Сохранено локально, но не в облаке. Войдите в аккаунт и повторите синхронизацию.';
    case 'conflict': return 'Сохранено локально, но не в облаке: конфликт с удалённой версией. Автоматическая перезапись остановлена.';
    case 'uncertain': return 'Сохранено локально; результат записи в облако неизвестен. Автоматический повтор остановлен, проверьте файл в облаке.';
    case 'legacy': return 'Старая локальная версия сохранена; сохранение в облаке не подтверждено. Для неё нет надёжной базы сравнения; автоматическая отправка заблокирована.';
    case 'ownership-unavailable': return 'Сохранено локально. Для синхронизации нужен браузер с поддержкой Web Locks.';
    case 'storage-error': return 'Ошибка локального хранилища. Подтверждение сохранения недоступно.';
    case 'not-found': return 'Заметка не найдена в облаке.';
    case 'validation-error': return 'Некорректный документ. Отправка в облако заблокирована.';
    case 'write-unsupported': return 'Сохранено локально. Провайдер не поддерживает требуемую безопасную запись; отправка недоступна.';
    case 'remote-unavailable': return 'Сохранено локально, но не в облаке. Сервис недоступен; повторим синхронизацию позже.';
  }
}
