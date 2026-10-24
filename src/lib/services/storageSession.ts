import { writable } from 'svelte/store';
import type { StorageDescriptor } from '../server/cloud/storageRegistry';
import { DBService, initialDatabase, bindDatabase } from './dbService';
import { createContextDatabase } from './localStorageContexts';
import { runIndexedDbTransaction } from '../adapters/indexedDb/transaction';
import { parseStorageCatalog, parseStorageDescriptor } from './storageCatalog';
import { cloudRequestSignal } from '../utils/cloudRequestSignal';
import { sessionGeneration } from '../stores/sessionState';

export interface StorageSession {
  descriptor: StorageDescriptor | null;
  database: DBService;
  verified: boolean;
  deliverySignal: AbortSignal;
}

export interface LocalStorageContext {
  id: string;
  label: string;
  contextId: string;
  storageId: string;
  rootPath?: string;
  database: DBService;
}

interface Manifest {
  contexts: StorageDescriptor[];
  active: string | null;
}

let session: StorageSession | null = null;
export const currentStorageSession = writable<StorageSession | null>(null);
let delivery: AbortController | undefined;
let generation = 0;
let pending: Promise<StorageSession> | undefined;

async function manifest(update?: {
  contexts: StorageDescriptor[];
  active?: string;
  remove?: string;
  restore?: boolean;
}): Promise<Manifest> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsContexts', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('contexts', { keyPath: 'contextId' });
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Storage context manifest blocked'));
  });
  try {
    let contexts: unknown[] = [];
    let active: unknown;
    await runIndexedDbTransaction(
      database,
      ['contexts', 'meta'],
      update ? 'readwrite' : 'readonly',
      transaction => {
        const meta = transaction.objectStore('meta');
        const store = transaction.objectStore('contexts');
        const previous = store.getAll();
        previous.onsuccess = () => {
          contexts = previous.result;
        };
        const deleted = meta.get('removed');
        deleted.onsuccess = () => {
          const suppressed = new Set<string>(deleted.result ?? []);
          if (update) {
            if (update.remove) {
              suppressed.add(update.remove);
              store.delete(update.remove.slice('local:'.length));
            }
            for (const descriptor of update.contexts) {
              const id = `local:${descriptor.contextId}`;
              if (update.restore || update.active === descriptor.contextId) suppressed.delete(id);
              if (!suppressed.has(id)) {
                const saved = contexts
                  .map(parseStorageDescriptor)
                  .find(item => item?.contextId === descriptor.contextId);
                store.put(
                  descriptor.rootPath === undefined && saved?.rootPath !== undefined
                    ? { ...descriptor, rootPath: saved.rootPath }
                    : descriptor
                );
              }
            }
            meta.put([...suppressed], 'removed');
            if (update.active !== undefined) meta.put(update.active, 'active');
          }
          const all = store.getAll();
          all.onsuccess = () => {
            contexts = all.result;
          };
          const last = meta.get('active');
          last.onsuccess = () => {
            active = last.result;
          };
        };
      }
    );
    const descriptors = contexts.map(parseStorageDescriptor);
    if (descriptors.some(item => item === null))
      throw new Error('Invalid storage context manifest');
    return {
      contexts: descriptors as StorageDescriptor[],
      active: typeof active === 'string' ? active : null
    };
  } finally {
    database.close();
  }
}

function publish(descriptor: StorageDescriptor | null, verified: boolean): StorageSession {
  delivery?.abort();
  delivery = new AbortController();
  if (!verified) delivery.abort();
  const database =
    session?.descriptor?.contextId === descriptor?.contextId && session
      ? session.database
      : descriptor
        ? createContextDatabase(descriptor.contextId)
        : initialDatabase;
  const captured = descriptor ? structuredClone(descriptor) : null;
  if (captured) {
    Object.freeze(captured.capabilities);
    Object.freeze(captured);
  }
  session = Object.freeze({
    descriptor: captured,
    database,
    verified,
    deliverySignal: delivery.signal
  });
  bindDatabase(database);
  currentStorageSession.set(session);
  return session;
}

export function getStorageSession(): StorageSession | null {
  return session;
}

export function initializeStorageSession(authenticated: boolean): Promise<StorageSession> {
  if (!authenticated) {
    ++generation;
    pending = undefined;
    if (session) return Promise.resolve(publish(session.descriptor, false));
    const request = generation;
    return manifest().then(saved =>
      request === generation
        ? publish(saved.contexts.find(item => item.contextId === saved.active) ?? null, false)
        : session!
    );
  }
  if (session?.verified) return Promise.resolve(session);
  if (pending) return pending;
  const request = ++generation;
  const authentication = sessionGeneration();
  const current = async () => {
    const saved = await manifest();
    if (request !== generation) return session!;
    let catalog: ReturnType<typeof parseStorageCatalog> = null;
    try {
      const signal = cloudRequestSignal();
      const response = await fetch('/api/storages', { signal });
      if (response.ok) {
        catalog = parseStorageCatalog(await response.json());
        if (signal.aborted) catalog = null;
      }
    } catch {
      /* A cached context grants reading, never delivery authority. */
    }
    if (request !== generation || authentication !== sessionGeneration())
      return session ?? publish(null, false);
    const active = catalog?.storages.find(item => item.id === catalog.activeStorageId);
    if (active?.status !== 'available')
      return publish(saved.contexts.find(item => item.contextId === saved.active) ?? null, false);
    try {
      await manifest({
        contexts: catalog!.storages.filter(
          (item): item is StorageDescriptor & { status: 'available' } => item.status === 'available'
        ),
        active: active.contextId
      });
    } catch {
      throw new Error('Failed to remember storage contexts');
    }
    if (request !== generation || authentication !== sessionGeneration())
      return session ?? publish(null, false);
    return publish(active, true);
  };
  const promise = current();
  pending = promise;
  void promise
    .finally(() => {
      if (pending === promise) pending = undefined;
    })
    .catch(() => {});
  return promise;
}

export async function listLocalStorageContexts(): Promise<LocalStorageContext[]> {
  const saved = await manifest();
  return saved.contexts.map(descriptor => ({
    id: `local:${descriptor.contextId}`,
    label: `Локальный кеш · ${descriptor.label} · ${descriptor.contextId.slice(-8)}`,
    contextId: descriptor.contextId,
    storageId: descriptor.id,
    ...(descriptor.rootPath === undefined ? {} : { rootPath: descriptor.rootPath }),
    database: createContextDatabase(descriptor.contextId)
  }));
}

// Register separately verified inventory contexts without retargeting the app.
export async function rememberStorageContexts(
  contexts: StorageDescriptor[],
  restore = false
): Promise<void> {
  try {
    await manifest({ contexts, restore });
  } catch {
    throw new Error('Failed to remember storage contexts');
  }
}

export async function forgetLocalStorageContext(id: string): Promise<void> {
  await manifest({ contexts: [], remove: id });
}
