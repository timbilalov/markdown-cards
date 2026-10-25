import { copyCloudNote } from '../adapters/manualCloudCopy';
import { createContextDatabase } from './localStorageContexts';
import type { NoteInventoryRow, StorageSnapshot } from '../domain/storageSync';
import { buildNoteInventory } from '../domain/storageSync';
import type { NoteStorage, NoteStorageReader } from '../ports/noteStorage';
import { BrowserCloudStorage } from '../adapters/browserCloudStorage';
import { LocalNoteStorage } from '../adapters/localNoteStorage';
import {
  readStorageInventory,
  type StorageInventoryProgress
} from '../application/storageInventory';
import { parseStorageCatalog } from './storageCatalog';
import { listLocalStorageContexts, rememberStorageContexts } from './storageSession';
import { cloudRequestSignal } from '../utils/cloudRequestSignal';
import { expireSession, sessionGeneration } from '../stores/sessionState';

export interface StorageColumn {
  id: string;
  label: string;
  kind: 'cloud' | 'local';
  contextId: string | null;
  active: boolean;
  rootPath?: string;
  storageId?: string | null;
}

export interface StorageComparison {
  catalogError: string | null;
  columns: StorageColumn[];
  snapshots: StorageSnapshot[];
  rows: NoteInventoryRow[];
  storages: Map<string, NoteStorage>;
}

export async function loadStorageComparison(
  signal?: AbortSignal,
  onProgress?: (progress: StorageInventoryProgress) => void
): Promise<StorageComparison> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const authentication = sessionGeneration();
  let catalog: ReturnType<typeof parseStorageCatalog> = null;
  try {
    const response = await fetch('/api/storages', { signal: cloudRequestSignal(signal) });
    if (response.status === 401) expireSession(authentication);
    if (response.ok) catalog = parseStorageCatalog(await response.json());
  } catch {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const verified = catalog?.storages.filter(item => item.status === 'available') ?? [];
  if (verified.length) await rememberStorageContexts(verified);
  const active = verified.find(item => item.id === catalog?.activeStorageId);
  const columns: StorageColumn[] = [];
  const storages = new Map<string, NoteStorage>();
  const sources: (NoteStorageReader | { id: string; unavailable: true })[] = [];
  if (catalog) {
    for (const entry of catalog.storages) {
      columns.push({
        id: entry.id,
        label: entry.label,
        kind: 'cloud',
        contextId: entry.status === 'available' ? entry.contextId : null,
        active: entry.id === catalog.activeStorageId,
        ...(entry.rootPath === undefined ? {} : { rootPath: entry.rootPath })
      });
      if (entry.status === 'available') {
        const cloud = new BrowserCloudStorage(entry, `/api/storages/${entry.id}`);
        const reader: NoteStorageReader = {
          id: entry.id,
          list: () => cloud.list(signal),
          read: (path, readSignal) => cloud.readListed(path, readSignal)
        };
        sources.push(reader);
        const database = createContextDatabase(entry.contextId);
        storages.set(entry.id, {
          ...reader,
          label: entry.label,
          kind: 'cloud',
          contextId: entry.contextId,
          caseSensitive: entry.capabilities.caseSensitivePaths !== false,
          copy: async input => {
            let started = false;
            try {
              await rememberStorageContexts([entry], true);
              const local = await database.getManualSyncRepository();
              if ((await local.prepareCloud(input.path)) === 'uncertain')
                return { status: 'conflict' };
              started = true;
              const result = await copyCloudNote(entry, input);
              if (result.status === 'written') await local.finishCloud(input.path, input.source);
              return result;
            } catch {
              return {
                status: 'unavailable',
                reason: 'remote',
                outcome: started ? 'unknown' : 'not-written'
              };
            }
          }
        });
      } else sources.push({ id: entry.id, unavailable: true });
    }
  } else {
    columns.push({
      id: 'cloud:unavailable',
      label: 'Облака · каталог недоступен',
      kind: 'cloud',
      contextId: null,
      active: false
    });
    sources.push({ id: 'cloud:unavailable', unavailable: true });
  }
  for (const local of await listLocalStorageContexts()) {
    columns.push({
      id: local.id,
      label: local.label,
      kind: 'local',
      contextId: local.contextId,
      storageId: local.storageId,
      active: local.contextId === active?.contextId,
      ...(local.rootPath === undefined ? {} : { rootPath: local.rootPath })
    });
    const reader = Object.assign(new LocalNoteStorage(local.database), { id: local.id });
    sources.push(reader);
    storages.set(local.id, {
      id: local.id,
      label: local.label,
      kind: 'local',
      contextId: local.contextId,
      caseSensitive: true,
      list: () => reader.list(),
      read: path => reader.read(path),
      copy: async input => {
        if (!(await listLocalStorageContexts()).some(entry => entry.id === local.id))
          return { status: 'conflict' };
        return (await local.database.getManualSyncRepository()).copy(input);
      }
    });
  }
  const snapshots = await readStorageInventory(sources, signal, onProgress);
  return {
    catalogError: catalog
      ? null
      : 'Каталог облачных хранилищ недоступен. Показаны локальные копии.',
    columns,
    snapshots,
    rows: buildNoteInventory(snapshots),
    storages
  };
}
