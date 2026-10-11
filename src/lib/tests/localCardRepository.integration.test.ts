// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbLocalCardRepository } from '../adapters/indexedDb/localCardRepository';
import type { LocalCardRepository } from '../ports/localCardRepository';
import type { Card } from '../domain/types';
import { makeCard, storedCard } from './helpers/fixtures';
import { legacyRecords } from './helpers/legacyDatabase';
import { v1 } from './helpers/markdownReadFixtures';

const original = makeCard({ title: 'Z title', meta: { id: 'a-card', created: 123, modified: 456 } });
const other = makeCard({ title: 'A title', meta: { id: 'z-card', created: 321, modified: 654 } });
const replacement = makeCard({ title: 'Changed 🗂', meta: { ...original.meta, modified: 789 } });
const filename = 'archive.md.Заметка';
const source = { filename, source: v1 };
const snapshot = { ...source, saveMode: 'update' };
const actions = ['read', 'list', 'write', 'delete'] as const;
type Action = typeof actions[number];
let database: IDBDatabase;
let repository: LocalCardRepository;

// Independent physical v4 fixture: no DBService or repository creates the data.
async function openFixture(name = 'MarkdownCardsDB', includeCards = true): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 4);
    request.onupgradeneeded = () => {
      const connection = request.result;
      if (includeCards) {
        const cards = connection.createObjectStore('cards', { keyPath: 'meta.id' });
        cards.createIndex('title', 'meta.title');
        cards.createIndex('modified', 'meta.modified');
        // Reverse insertion order and title order to distinguish primary-key listing.
        cards.put(storedCard(other));
        cards.put(storedCard(original));
      }
      const files = connection.createObjectStore('files', { keyPath: 'path' });
      files.createIndex('name', 'name');
      files.createIndex('modified', 'modified');
      const queue = connection.createObjectStore('syncQueue', { keyPath: 'id' });
      queue.createIndex('timestamp', 'timestamp');
      queue.createIndex('status', 'status');
      for (const file of legacyRecords.files) files.put(file);
      for (const operation of legacyRecords.syncQueue) queue.put(operation);
      connection.createObjectStore('markdownDocuments', { keyPath: 'filename' }).put(source);
      connection.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' }).put(snapshot);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredState() {
  const connection = await openFixture();
  try {
    return await new Promise<{ version: number; records: Record<string, unknown[]> }>((resolve, reject) => {
      const names = [...connection.objectStoreNames];
      const transaction = connection.transaction(names, 'readonly');
      const requests = names.map(name => [name, transaction.objectStore(name).getAll()] as const);
      transaction.oncomplete = () => resolve({ version: connection.version,
        records: Object.fromEntries(requests.map(([name, request]) => [name, request.result]))
      });
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    connection.close();
  }
}

function perform(action: Action, target: LocalCardRepository = repository) {
  switch (action) {
    case 'read': return target.read(original.meta.id);
    case 'list': return target.list();
    case 'write': return target.write(replacement);
    case 'delete': return target.delete(original.meta.id);
  }
}

function abortAfterRequestSuccess(action: Action) {
  // All four methods return IDBRequest; keep the actual native operation running
  // and abort only after its success event, before the transaction can commit.
  const method = { read: 'get', list: 'getAll', write: 'put', delete: 'delete' } as const;
  const originalMethod = IDBObjectStore.prototype[method[action]];
  return vi.spyOn(IDBObjectStore.prototype, method[action]).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    const request = Reflect.apply(originalMethod, this, args) as IDBRequest;
    if (this.name === 'cards') request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
}

beforeEach(async () => {
  database = await openFixture();
  repository = new IndexedDbLocalCardRepository(database);
});

describe('LocalCardRepository: existing projections and storage isolation', () => {
  it('reads a deployed Card with all fields, exact timestamps and index alias intact', async () => {
    const before = await readStoredState();
    expect(await repository.read(original.meta.id)).toEqual(storedCard(original));
    expect(await readStoredState()).toEqual(before);
  });

  it('returns null only for a missing ID, without treating the source filename as a Card ID', async () => {
    expect(await repository.read('missing')).toBeNull();
    expect(await repository.read(filename)).toBeNull();
  });

  it('lists all records by primary key, independently of title and insertion order', async () => {
    const before = await readStoredState();
    expect(await repository.list()).toEqual([storedCard(original), storedCard(other)]);
    expect(await readStoredState()).toEqual(before);
  });

  it('returns an empty list and absent read without inventing Cards from sources, snapshots or old queue rows', async () => {
    const transaction = database.transaction('cards', 'readwrite');
    transaction.objectStore('cards').clear();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const before = await readStoredState();
    expect(await repository.list()).toEqual([]);
    expect(await repository.read('test-card')).toBeNull();
    expect(await readStoredState()).toEqual(before);
  });

  it('isolates nested objects returned by read and list from each other and future reads', async () => {
    const card = await repository.read(original.meta.id);
    const cards = await repository.list();
    expect(card).toEqual(storedCard(original));
    expect(cards).toEqual([storedCard(original), storedCard(other)]);
    if (!card) throw new Error('Expected stored Card');
    card.meta.id = 'changed';
    card.sections[0].items[0].text = 'changed';
    cards[0].tags?.push('changed');
    cards[0].title = 'changed';
    expect(await repository.read(original.meta.id)).toEqual(storedCard(original));
    expect(await repository.list()).toEqual([storedCard(original), storedCard(other)]);
  });

  it('replaces only the addressed Card, preserving schema, drafts, sources, files and every legacy queue status', async () => {
    const before = await readStoredState();
    await repository.write(replacement);
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, cards: [storedCard(replacement), storedCard(other)]
    } });
    // The deployed indexes remain usable after an update; stale aliases are gone.
    const transaction = database.transaction('cards', 'readonly');
    const cards = transaction.objectStore('cards');
    const oldTitle = cards.index('title').getAll(original.title);
    const newTitle = cards.index('title').getAll(replacement.title);
    const modified = cards.index('modified').getAll(replacement.meta.modified);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    expect(oldTitle.result).toEqual([]);
    expect(newTitle.result).toEqual([storedCard(replacement)]);
    expect(modified.result).toEqual([storedCard(replacement)]);
  });

  it('creates a minimal Card without inventing optional fields or changing timestamps', async () => {
    const card: Card = { title: '', meta: { id: 'new-card', created: 0, modified: 0 }, description: '', sections: [] };
    const before = await readStoredState();
    await repository.write(card);
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, cards: [storedCard(original), storedCard(card), storedCard(other)]
    } });
    expect(card).toEqual({ title: '', meta: { id: 'new-card', created: 0, modified: 0 }, description: '', sections: [] });
  });

  it('captures nested caller input before awaiting and refreshes a stale legacy title alias', async () => {
    const card = { ...makeCard(), meta: { ...original.meta, title: 'Stale alias' } };
    const expected = storedCard(structuredClone(card));
    const writing = repository.write(card);
    card.meta.id = 'changed';
    card.title = 'changed';
    card.sections[0].items[0].text = 'changed';
    card.tags?.push('changed');
    await writing;
    expect((await readStoredState()).records.cards).toEqual([expected, storedCard(other)]);
    expect(await repository.read('changed')).toBeNull();
  });

  it('persists a write across an owner reconnect without opening or upgrading storage itself', async () => {
    await repository.write(replacement);
    database.close();
    database = await openFixture();
    expect(await new IndexedDbLocalCardRepository(database).read(original.meta.id)).toEqual(storedCard(replacement));
    expect(database.version).toBe(4);
  });

  it('deletes only the selected Card and permits repeated or missing-ID removal', async () => {
    const before = await readStoredState();
    await repository.delete(original.meta.id);
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, cards: [storedCard(other)]
    } });
    await repository.delete(original.meta.id);
    await repository.delete('missing');
    expect(await repository.read(original.meta.id)).toBeNull();
    expect(await repository.list()).toEqual([storedCard(other)]);
  });

  it('uses only cards transactions on the borrowed connection and leaves connection ownership to its caller', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const transactions = vi.spyOn(database, 'transaction');
    expect(await repository.read(original.meta.id)).toEqual(storedCard(original));
    expect(await repository.list()).toEqual([storedCard(original), storedCard(other)]);
    await repository.write(replacement);
    await repository.delete(other.meta.id);
    expect(transactions).toHaveBeenCalledTimes(4);
    expect(transactions.mock.results.map(result => {
      const transaction: IDBTransaction = result.value;
      return { stores: [...transaction.objectStoreNames], mode: transaction.mode };
    })).toEqual(['readonly', 'readonly', 'readwrite', 'readwrite'].map(mode => ({ stores: ['cards'], mode })));
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('LocalCardRepository: commit boundaries and propagated errors', () => {
  it.each(actions)('rejects %s aborted after request success and retains all previous records', async action => {
    const before = await readStoredState();
    const spy = abortAfterRequestSuccess(action);
    await expect(perform(action)).rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    expect(await readStoredState()).toEqual(before);
  });

  it.each(actions)('rejects %s on a closed connection instead of reopening or reporting absence/success', async action => {
    const before = await readStoredState();
    database.close();
    const open = vi.spyOn(indexedDB, 'open');
    await expect(perform(action)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(open).not.toHaveBeenCalled();
    expect(await readStoredState()).toEqual(before);
  });

  it.each(actions)('rejects %s without a cards store instead of repairing the owner schema', async action => {
    const connection = await openFixture('missing-cards', false);
    const incomplete = new IndexedDbLocalCardRepository(connection);
    await expect(perform(action, incomplete)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(connection.version).toBe(4);
    expect([...connection.objectStoreNames]).not.toContain('cards');
  });

  it('propagates the original quota error once without overwriting the previous Card', async () => {
    const before = await readStoredState();
    const error = new DOMException('Card quota exhausted', 'QuotaExceededError');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw error; });
    await expect(repository.write(replacement)).rejects.toBe(error);
    expect(put).toHaveBeenCalledTimes(1);
    put.mockRestore();
    expect(await readStoredState()).toEqual(before);
  });

  it('propagates a synchronous read failure once without disguising it as a missing Card', async () => {
    const before = await readStoredState();
    const error = new DOMException('Card transaction is inactive', 'TransactionInactiveError');
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => { throw error; });
    await expect(repository.read(original.meta.id)).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
    get.mockRestore();
    expect(await readStoredState()).toEqual(before);
  });
});
