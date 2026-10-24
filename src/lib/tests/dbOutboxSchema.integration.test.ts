import { historicalStorage } from './helpers/historicalStorage';
import { describe, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb';
import { DBError, DBService, DBTransactionError } from '../services/dbService';
import { IndexedDbOutboxRepository } from '../adapters/indexedDb/outboxRepository';
import type { OutboxOperation, OutboxState } from '../domain/outbox';
import { legacyRecords, seedLegacyDatabase } from './helpers/legacyDatabase';
import { v1 } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const filename = 'Архив.md.🗂';
const sources = [
  { filename, source: legacy.replaceAll('\n', '\r\n') },
  { filename: 'future-format', source: v1.replace('markdown-cards: 1', 'markdown-cards: 99') }
];
const snapshots = [
  { filename, source: v1 + '\n\n', saveMode: 'update' },
  { filename: 'new-note', source: v1, saveMode: 'create' }
];
const states: OutboxState[] = [
  { status: 'pending', nextAttemptAt: 100 },
  { status: 'processing', deliveryId: 'delivery-1', startedAt: 200 },
  { status: 'failed', reason: 'network', nextAttemptAt: 1000 },
  { status: 'uncertain', deliveryId: 'delivery-3', reason: 'interrupted' },
  { status: 'conflict' },
  { status: 'completed', revision: 'new-revision', completedAt: 300 }
];
const operations: OutboxOperation[] = states.map((state, index) => ({
  id: `save-${index}`, cardId: 'test-card', path: `${filename}.md`, source: v1,
  createOnly: false, base: { kind: 'present', revision: 'opaque-base' },
  createdAt: 100 - index, attempts: index, state
}));
const storeNames = ['cards', 'files', 'localMarkdownSnapshots', 'manualSyncArchives', 'markdownDocuments', 'outbox', 'syncQueue'];

function openCurrent(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Independent older physical schemas. withOutbox is a compatibility fixture
// (v4 plus the future store), used to isolate clear-all behavior on today's code.
async function seed(version: 2 | 3 | 4, withOutbox = false) {
  await seedLegacyDatabase();
  if (version === 2) return;
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB', version);
    request.onupgradeneeded = () => {
      const db = request.result;
      const sourceStore = db.createObjectStore('markdownDocuments', { keyPath: 'filename' });
      for (const source of sources) sourceStore.put(source);
      if (version === 4) {
        const snapshotStore = db.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' });
        for (const snapshot of snapshots) snapshotStore.put(snapshot);
      }
      if (withOutbox) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        for (const operation of operations) outbox.add(operation);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  connection.close();
}

async function readState() {
  const db = await openCurrent();
  try {
    return await new Promise<{
      version: number;
      records: Record<string, unknown[]>;
      schema: Record<string, { keyPath: string | string[] | null; autoIncrement: boolean;
        indexes: Record<string, { keyPath: string | string[]; unique: boolean; multiEntry: boolean }> }>;
    }>((resolve, reject) => {
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readonly');
      const stores = names.map(name => tx.objectStore(name));
      const requests = stores.map(store => store.getAll());
      const schema = Object.fromEntries(stores.map(store => [store.name, {
        keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: Object.fromEntries([...store.indexNames].map(name => {
          const index = store.index(name);
          return [name, { keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }];
        }))
      }]));
      tx.oncomplete = () => resolve({ version: db.version, schema,
        records: Object.fromEntries(names.map((name, i) => [name, requests[i].result])) });
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const plainStore = (keyPath: string) => ({ keyPath, autoIncrement: false, indexes: {} });

describe('DBService: additive v6 schema with retained outbox', () => {
  it('creates all stores on a fresh database and provides a usable outbox', async () => {
    const service = new DBService();
    await service.init();
    const state = await readState();
    expect(state.version).toBe(6);
    expect(Object.keys(state.records)).toEqual(storeNames);
    expect(Object.values(state.records)).toEqual(storeNames.map(() => []));
    expect(state.schema.outbox).toEqual(plainStore('id'));
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 1, errors: 0 });
    const connection = await openCurrent();
    await new IndexedDbOutboxRepository(connection).add(operations[0]);
    connection.close();
    await new DBService().init();
    expect((await readState()).records.outbox).toEqual([operations[0]]);
  });

  it.each([2, 3, 4] as const)('upgrades v%i preserving every old record, index and source verbatim', async version => {
    await seed(version);
    const before = await readState();
    const service = new DBService();
    await service.init();
    const after = await readState();
    expect(after.version).toBe(6);
    expect(Object.keys(after.records)).toEqual(storeNames);
    expect(after.records).toEqual({ markdownDocuments: [], localMarkdownSnapshots: [],
      ...before.records, outbox: [], manualSyncArchives: [] });
    expect(after.schema).toEqual({ markdownDocuments: plainStore('filename'),
      localMarkdownSnapshots: plainStore('filename'), ...before.schema, outbox: plainStore('id'), manualSyncArchives: plainStore('id') });
    expect(await historicalStorage.getPendingSyncOperations())
      .toEqual(legacyRecords.syncQueue.filter(operation => operation.status === 'pending'));
    const connection = await openCurrent();
    expect(await new IndexedDbOutboxRepository(connection).list()).toEqual([]);
    connection.close();
    expect(await readState()).toEqual(after);
  });

  it('reopens populated v5 without replaying, resetting or deleting any operation', async () => {
    await seed(4, true);
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MarkdownCardsDB', 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    connection.close();
    const before = await readState();
    const service = new DBService();
    await expect(service.init()).resolves.toBeUndefined();
    expect(await readState()).toEqual({ ...before, version: 6, records: { ...before.records, manualSyncArchives: [] }, schema: { ...before.schema, manualSyncArchives: plainStore('id') } });
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 1, errors: 0 });
  });

  it('preserves an already present outbox during an additive upgrade', async () => {
    await seed(4, true);
    const before = await readState();
    await new DBService().init();
    expect(await readState()).toEqual({ ...before, version: 6, records: { ...before.records, manualSyncArchives: [] }, schema: { ...before.schema, manualSyncArchives: plainStore('id') } });
  });

  it('rolls back an aborted v4 upgrade and permits an explicit retry', async () => {
    await seed(4);
    const before = await readState();
    const service = new DBService();
    const open = indexedDB.open.bind(indexedDB);
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      const request = open(...args);
      request.addEventListener('upgradeneeded', () => {
        queueMicrotask(() => request.transaction?.abort());
      });
      return request;
    });
    await expect(service.init()).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1 });
    service.resetPerformanceMetrics();
    await service.init();
    expect((await readState()).records).toEqual({ ...before.records, outbox: [], manualSyncArchives: [] });
    expect((await readState()).version).toBe(6);
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 1, errors: 0 });
  });

  it('rejects a thrown schema creation error without an uncaught event error or partial upgrade', async () => {
    await seed(4);
    const before = await readState();
    const service = new DBService();
    const create = IDBDatabase.prototype.createObjectStore;
    const spy = vi.spyOn(IDBDatabase.prototype, 'createObjectStore').mockImplementation(function (this: IDBDatabase, name, options) {
      if (name === 'outbox') throw new DOMException('Outbox schema quota', 'QuotaExceededError');
      return create.call(this, name, options);
    });
    await expect(service.init()).rejects.toBeInstanceOf(DBError);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1 });
    service.resetPerformanceMetrics();
    await service.init();
    expect((await readState()).version).toBe(6);
    expect((await readState()).records).toEqual({ ...before.records, outbox: [], manualSyncArchives: [] });
  });

  it('reports a blocked upgrade once and prevents the rejected request from upgrading later', async () => {
    await seed(4);
    const before = await readState();
    const blocker = await openCurrent(); // Simulates another tab running old code.
    const service = new DBService();
    const requests: IDBOpenDBRequest[] = [];
    const open = indexedDB.open.bind(indexedDB);
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      const request = open(...args);
      requests.push(request);
      return request;
    });
    await expect(service.init()).rejects.toMatchObject({ code: 'OPEN_BLOCKED' });
    expect(requests).toHaveLength(1);
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1 });
    const terminal = new Promise<string>(resolve => {
      requests[0].addEventListener('success', () => resolve('success'));
      requests[0].addEventListener('error', () => resolve('error'));
    });
    blocker.close();
    expect(await terminal).toBe('error');
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1 });
    service.resetPerformanceMetrics();
    await service.init();
    expect((await readState()).version).toBe(6);
    expect((await readState()).records).toEqual({ ...before.records, outbox: [], manualSyncArchives: [] });
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 1, errors: 0 });
  });
});

describe('DBService: explicit clear-all includes outbox in the same transaction', () => {
  it('clears all seven stores, including every outbox state, on explicit clear-all', async () => {
    await seed(4, true);
    const service = new DBService();
    await service.init();
    const before = await readState();
    await service.clearAllData();
    expect(await readState()).toEqual({ ...before,
      records: Object.fromEntries(storeNames.map(name => [name, []])) });
  });

  it('rolls back every store if outbox clear aborts after request success', async () => {
    await seed(4, true);
    const service = new DBService();
    await service.init();
    const before = await readState();
    const clear = IDBObjectStore.prototype.clear;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore) {
      const request = clear.call(this);
      if (this.name === 'outbox') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    // Keep the existing generic retry policy out of the wall-clock assertion.
    // Native IndexedDB tasks still run; only retry-delay timers are virtual.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.setTimerTickMode('nextTimerAsync');
    const clearing = service.clearAllData().then(
      () => ({ status: 'fulfilled' }), (error: unknown) => ({ status: 'rejected', error })
    );
    expect(await clearing).toMatchObject({ status: 'rejected', error: expect.any(DBTransactionError) });
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    await service.clearAllData();
    expect(await readState()).toEqual({ ...before,
      records: Object.fromEntries(storeNames.map(name => [name, []])) });
  });
});
