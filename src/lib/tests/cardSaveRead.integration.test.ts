import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbCardSaveRepository } from '../adapters/indexedDb/cardSaveRepository';
import type { CardSaveDraft, CardSaveSnapshot, SavedMarkdownDraft } from '../ports/cardSaveRepository';
import type { OutboxOperation, OutboxState } from '../domain/outbox';
import { legacyRecords } from './helpers/legacyDatabase';
import { v1, v1Card, futureV1Shape } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const databaseName = 'CardSaveReadTestDB';
const filename = 'Архив.md.🗂';
const path = `${filename}.md`;
const source = (v1 + '\n\n').replaceAll('\n', '\r\n');
const operation: OutboxOperation = {
  id: 'save-current', cardId: v1Card.meta.id, path, source, createOnly: false,
  base: { kind: 'present', revision: ' opaque/base ' }, createdAt: 1000, attempts: 2,
  state: { status: 'processing', deliveryId: 'delivery-A', startedAt: 2000 }
};
const draft: SavedMarkdownDraft = { filename, source, saveMode: 'update', saveId: operation.id };
const remote = { filename, source: futureV1Shape };
const snapshot: CardSaveSnapshot = { draft, operation, remote };
const stores = ['localMarkdownSnapshots', 'markdownDocuments', 'outbox'] as const;
type Store = typeof stores[number];
let database: IDBDatabase;
let repository: IndexedDbCardSaveRepository;

// Independent physical v5 fixture, including unrelated legacy records. The
// filename differs from Card ID, and remote source differs from the local Save.
function openFixture(name = databaseName, omitted?: Store): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      const cards = db.createObjectStore('cards', { keyPath: 'meta.id' });
      cards.createIndex('title', 'meta.title');
      cards.createIndex('modified', 'meta.modified');
      for (const row of legacyRecords.cards) cards.put(row);
      const files = db.createObjectStore('files', { keyPath: 'path' });
      for (const row of legacyRecords.files) files.put(row);
      const queue = db.createObjectStore('syncQueue', { keyPath: 'id' });
      for (const row of legacyRecords.syncQueue) queue.put(row);
      if (omitted !== 'localMarkdownSnapshots') {
        const drafts = db.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' });
        drafts.put(draft);
        drafts.put({ filename: 'other', source: legacy, saveMode: 'create' });
      }
      if (omitted !== 'markdownDocuments') {
        const documents = db.createObjectStore('markdownDocuments', { keyPath: 'filename' });
        documents.put(remote);
        documents.put({ filename: 'other', source: legacy });
      }
      if (omitted !== 'outbox') {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.put(operation);
        // Neither lexicographic order nor timestamp establishes the current Save.
        outbox.put({ ...operation, id: 'zz-other-save', createdAt: 999999,
          state: { status: 'completed', revision: 'other-revision', completedAt: 999999 } });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readState(name = databaseName) {
  const db = await openFixture(name);
  try {
    return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readonly');
      const requests = names.map(name => tx.objectStore(name).getAll());
      tx.oncomplete = () => resolve(Object.fromEntries(names.map((name, i) => [name, requests[i].result])));
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function changeRow(store: Store, row: unknown, deleteKey?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite');
    if (deleteKey !== undefined) tx.objectStore(store).delete(deleteKey);
    else tx.objectStore(store).put(row);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

function interceptRead(storeName: Store, effect: (store: IDBObjectStore, enqueue: () => IDBRequest) => IDBRequest) {
  const get = IDBObjectStore.prototype.get;
  return vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    const enqueue = () => get.apply(this, args);
    return this.name === storeName ? effect(this, enqueue) : enqueue();
  });
}

beforeEach(async () => {
  database = await openFixture();
  repository = new IndexedDbCardSaveRepository(database);
});

describe('CardSaveRepository: read one coherent local Save snapshot', () => {
  it('reads the exact current draft, linked operation and remote cache independently of Card ID and timestamps', async () => {
    const before = await readState();
    expect(await repository.readCurrent(path)).toEqual(snapshot);
    expect(await readState()).toEqual(before);
  });

  it('returns three explicit nulls for an absent path without substituting another Card or operation', async () => {
    expect(await repository.readCurrent('missing.md')).toEqual({ draft: null, operation: null, remote: null });
  });

  it('returns remote-only data without attaching outbox history for the same path', async () => {
    await changeRow('localMarkdownSnapshots', undefined, filename);
    expect(await repository.readCurrent(path)).toEqual({ draft: null, operation: null, remote });
  });

  it('returns local work and its base even when no remote source is cached', async () => {
    await changeRow('markdownDocuments', undefined, filename);
    expect(await repository.readCurrent(path)).toEqual({ ...snapshot, remote: null });
  });

  it('preserves a legacy snapshot without inventing a Save ID or enrolling it in outbox', async () => {
    const historical = { filename, source: legacy, saveMode: 'create' };
    await changeRow('localMarkdownSnapshots', historical);
    const before = await readState();
    expect(await repository.readCurrent(path)).toEqual({ draft: historical, operation: null, remote });
    expect(await readState()).toEqual(before);
  });

  it('exposes an orphan Save ID without treating it as clean or substituting another operation', async () => {
    await changeRow('outbox', undefined, operation.id);
    const before = await readState();
    expect(await repository.readCurrent(path)).toEqual({ ...snapshot, operation: null });
    expect(await readState()).toEqual(before);
  });

  it('exposes inconsistent linked payload verbatim for the use case to diagnose, without repair', async () => {
    const inconsistent = { ...operation, path: 'other.md', source: v1, createOnly: true };
    await changeRow('outbox', inconsistent);
    const before = await readState();
    expect(await repository.readCurrent(path)).toEqual({ ...snapshot, operation: inconsistent });
    expect(await readState()).toEqual(before);
  });

  const states: OutboxState[] = [
    { status: 'pending', nextAttemptAt: 2000 },
    { status: 'processing', deliveryId: 'active', startedAt: 2000 },
    { status: 'failed', reason: 'network', nextAttemptAt: 3000 },
    { status: 'failed', reason: 'auth', nextAttemptAt: null },
    { status: 'uncertain', deliveryId: 'interrupted', reason: 'interrupted' },
    { status: 'conflict' },
    { status: 'completed', revision: ' confirmed/revision ', completedAt: 4000 }
  ];
  it.each(states)('preserves $status metadata without recovering, acknowledging or starting delivery', async state => {
    const row = { ...operation, state };
    await changeRow('outbox', row);
    const before = await readState();
    expect(await repository.readCurrent(path)).toEqual({ ...snapshot, operation: row });
    expect(await readState()).toEqual(before);
  });

  it.each([
    { label: 'empty', value: '' }, { label: 'legacy', value: legacy },
    { label: 'future version', value: futureV1Shape }
  ])('returns a $label remote source without parsing or fallback to the draft', async ({ value }) => {
    const record = { filename, source: value };
    await changeRow('markdownDocuments', record);
    expect(await repository.readCurrent(path)).toEqual({ ...snapshot, remote: record });
  });

  it('detaches every returned record and nested operation field from storage and later reads', async () => {
    const before = await readState();
    const result = await repository.readCurrent(path);
    expect(result).toEqual(snapshot);
    result.draft!.source = 'caller edit';
    result.remote!.source = 'caller cache edit';
    Object.assign(result.operation!.base, { revision: 'caller revision' });
    Object.assign(result.operation!.state, { deliveryId: 'caller delivery' });
    expect(await repository.readCurrent(path)).toEqual(snapshot);
    expect(await readState()).toEqual(before);
  });
});

describe('CardSaveRepository: read transaction lifetime and failures', () => {
  it('uses one readonly transaction on the borrowed connection and fulfils only after complete', async () => {
    const events: string[] = [];
    const transaction = database.transaction.bind(database);
    const transactions = vi.spyOn(database, 'transaction').mockImplementation((...args) => {
      const tx = transaction(...args);
      tx.addEventListener('complete', () => events.push('complete'));
      return tx;
    });
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const result = await repository.readCurrent(path).then(value => { events.push('resolved'); return value; });
    expect(result).toEqual(snapshot);
    expect(events).toEqual(['complete', 'resolved']);
    expect(transactions.mock.results.map(result => {
      const tx: IDBTransaction = result.value;
      return { stores: [...tx.objectStoreNames], mode: tx.mode };
    })).toEqual([{ stores: [...stores], mode: 'readonly' }]);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it.each(stores)('rejects abort after successful %s read instead of returning partial data', async store => {
    const before = await readState();
    const events: string[] = [];
    const spy = interceptRead(store, (objectStore, enqueue) => {
      const request = enqueue();
      objectStore.transaction.addEventListener('abort', () => events.push('abort'));
      request.addEventListener('success', () => queueMicrotask(() => objectStore.transaction.abort()));
      return request;
    });
    await expect(repository.readCurrent(path).catch(error => { events.push('rejected'); throw error; }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['abort', 'rejected']);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it('does not return missing data before an aborted transaction completes', async () => {
    const spy = interceptRead('localMarkdownSnapshots', (store, enqueue) => {
      const request = enqueue();
      request.addEventListener('success', () => queueMicrotask(() => store.transaction.abort()));
      return request;
    });
    await expect(repository.readCurrent('missing.md')).rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
  });

  it.each(stores)('preserves the original synchronous %s error, waits for abort and permits explicit retry', async store => {
    const before = await readState();
    const events: string[] = [];
    const error = new DOMException('Snapshot read failed', 'UnknownError');
    let attempts = 0;
    const spy = interceptRead(store, objectStore => {
      attempts++;
      objectStore.transaction.addEventListener('abort', () => events.push('abort'));
      throw error;
    });
    await expect(repository.readCurrent(path).catch(reason => { events.push('rejected'); throw reason; }))
      .rejects.toBe(error);
    expect(events).toEqual(['abort', 'rejected']);
    expect(attempts).toBe(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(await repository.readCurrent(path)).toEqual(snapshot);
  });

  it('preserves a thrown undefined in the dependent operation read as rejection, not success', async () => {
    const spy = interceptRead('outbox', () => { throw undefined; });
    await expect(repository.readCurrent(path)).rejects.toBeUndefined();
    spy.mockRestore();
  });

  it('propagates transaction creation failure without retry', async () => {
    const error = new DOMException('Connection unavailable', 'InvalidStateError');
    const spy = vi.spyOn(database, 'transaction').mockImplementation(() => { throw error; });
    await expect(repository.readCurrent(path)).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects a closed connection without opening a replacement', async () => {
    database.close();
    const open = vi.spyOn(indexedDB, 'open');
    await expect(repository.readCurrent(path)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(open).not.toHaveBeenCalled();
  });

  it.each(stores)('rejects missing %s without repairing the schema or reporting absent data', async store => {
    const name = `Missing-${store}`;
    const db = await openFixture(name, store);
    const before = await readState(name);
    await expect(new IndexedDbCardSaveRepository(db).readCurrent(path)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await readState(name)).toEqual(before);
    expect([...db.objectStoreNames]).not.toContain(store);
    expect(db.version).toBe(5);
  });
});

describe('CardSaveRepository: reads concurrent with atomic Save and delivery acknowledgement', () => {
  it.each(['read-first', 'save-first'] as const)('sees a complete old or new Save across connections: %s', async order => {
    const writer = new IndexedDbCardSaveRepository(await openFixture());
    const input: CardSaveDraft = {
      id: 'next-save', path, document: { version: 1, source: v1, card: v1Card },
      createOnly: true, base: { kind: 'missing' }, createdAt: 500
    };
    const nextOperation: OutboxOperation = {
      id: input.id, path, source: v1, cardId: v1Card.meta.id, createOnly: true,
      base: { kind: 'missing' }, createdAt: 500, attempts: 0,
      state: { status: 'pending', nextAttemptAt: 500 }
    };
    const next: CardSaveSnapshot = {
      draft: { filename, source: v1, saveMode: 'create', saveId: input.id },
      operation: nextOperation, remote
    };
    const results = order === 'read-first'
      ? await Promise.all([repository.readCurrent(path), writer.save(input)])
      : await Promise.all([writer.save(input), repository.readCurrent(path)]);
    expect(results[order === 'read-first' ? 0 : 1]).toEqual(order === 'read-first' ? snapshot : next);
    expect(await repository.readCurrent(path)).toEqual(next);
  });

  it.each(['read-first', 'finish-first'] as const)('never combines an acknowledged draft with a stale remote source: %s', async order => {
    const writer = new IndexedDbCardSaveRepository(await openFixture());
    const finish = () => writer.finishDelivery(operation.id, {
      deliveryId: 'delivery-A', now: 3000, outcome: { status: 'written', revision: 'confirmed' },
      policy: { baseDelayMs: 1000, maxDelayMs: 5000 }
    });
    const acknowledged = { draft: null, operation: null, remote: { filename, source } };
    const results = order === 'read-first'
      ? await Promise.all([repository.readCurrent(path), finish()])
      : await Promise.all([finish(), repository.readCurrent(path)]);
    expect(results[order === 'read-first' ? 0 : 1]).toEqual(order === 'read-first' ? snapshot : acknowledged);
    expect(await repository.readCurrent(path)).toEqual(acknowledged);
  });
});
