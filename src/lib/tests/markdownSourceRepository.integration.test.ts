// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbMarkdownSourceRepository } from '../adapters/indexedDb/markdownSourceRepository';
import type { MarkdownSourceRepository, StoredMarkdownSource } from '../ports/markdownSourceRepository';
import { legacyRecords } from './helpers/legacyDatabase';
import { v1, v1Card, futureV1Shape, unknownMetadata } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const filename = 'archive.md.Заметка';
const databaseName = 'MarkdownCardsDB';
const originalDocument = { filename, source: legacy };
const otherDocument = { filename: 'Other-note', source: v1 };
const pendingSnapshot = { filename, source: v1.replace('# Карточка 🗂', '# Pending edit'), saveMode: 'update' };
const sourceCases = [
  { label: 'v1 with original timezone, CRLF and trailing whitespace',
    source: (v1.replace('2026-09-25T12:34:56.789Z', '2026-09-25T15:34:56.789+03:00') + '\n\n').replaceAll('\n', '\r\n') },
  { label: 'legacy with CRLF', source: legacy.replaceAll('\n', '\r\n') },
  { label: 'future version', source: futureV1Shape },
  { label: 'unsupported metadata', source: unknownMetadata },
  { label: 'empty source', source: '' },
  { label: 'arbitrary Markdown with BOM and Unicode', source: '\uFEFF# Текст 🗂\r\n\r\n  свободный текст\t' }
];
let database: IDBDatabase;
let repository: MarkdownSourceRepository;

// Independently seed the deployed v4 schema and old records. No DBService or
// repository implementation participates in setup or the persistence oracle.
async function openFixture(name = databaseName, includeDocuments = true): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 4);
    request.onupgradeneeded = () => {
      const connection = request.result;
      const cards = connection.createObjectStore('cards', { keyPath: 'meta.id' });
      cards.createIndex('title', 'meta.title');
      cards.createIndex('modified', 'meta.modified');
      const files = connection.createObjectStore('files', { keyPath: 'path' });
      files.createIndex('name', 'name');
      files.createIndex('modified', 'modified');
      const queue = connection.createObjectStore('syncQueue', { keyPath: 'id' });
      queue.createIndex('timestamp', 'timestamp');
      queue.createIndex('status', 'status');
      for (const record of legacyRecords.cards) cards.put(record);
      for (const record of legacyRecords.files) files.put(record);
      for (const record of legacyRecords.syncQueue) queue.put(record);
      if (includeDocuments) {
        const documents = connection.createObjectStore('markdownDocuments', { keyPath: 'filename' });
        documents.put(originalDocument);
        documents.put(otherDocument);
      }
      connection.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' }).put(pendingSnapshot);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedSource(document: StoredMarkdownSource): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('markdownDocuments', 'readwrite');
    transaction.objectStore('markdownDocuments').put(document);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readFixture() {
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

function abortAfterRequestSuccess(action: 'read' | 'write') {
  function scheduleAbort<T>(store: IDBObjectStore, request: IDBRequest<T>) {
    if (store.name === 'markdownDocuments') request.addEventListener('success', () => store.transaction.abort());
  }
  if (action === 'read') {
    const get = IDBObjectStore.prototype.get;
    return vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = get.apply(this, args);
      scheduleAbort(this, request);
      return request;
    });
  }
  const put = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = put.apply(this, args);
    scheduleAbort(this, request);
    return request;
  });
}

beforeEach(async () => {
  database = await openFixture();
  repository = new IndexedDbMarkdownSourceRepository(database);
});

describe('MarkdownSourceRepository: exact reads from the deployed source cache', () => {
  it.each(sourceCases)('reads $label without migration, normalization or a partial Card', async ({ source }) => {
    const document = { filename, source };
    await seedSource(document);
    const before = await readFixture();
    expect(await repository.read(filename)).toEqual(document);
    expect(await readFixture()).toEqual(before);
  });

  it('returns null for a missing filename without inventing source from the Card ID', async () => {
    const before = await readFixture();
    expect(await repository.read(v1Card.meta.id)).toBeNull();
    expect(await repository.read('missing')).toBeNull();
    expect(await readFixture()).toEqual(before);
  });

  it('does not return a pending local snapshot as a downloaded source', async () => {
    const transaction = database.transaction('markdownDocuments', 'readwrite');
    transaction.objectStore('markdownDocuments').delete(filename);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const before = await readFixture();
    expect(await repository.read(filename)).toBeNull();
    expect(await readFixture()).toEqual(before);
  });

  it('keeps filenames case-sensitive and independent even when their document IDs match', async () => {
    const documents = ['note', 'Note', 'Заметка 🗂', 'archive.md.note'].map((name, index) => ({
      filename: name, source: v1.replace('# Карточка 🗂', `# Copy ${index}`)
    }));
    for (const document of documents) await seedSource(document);
    expect(await Promise.all(documents.map(document => repository.read(document.filename)))).toEqual(documents);
  });

  it('isolates returned objects from later reads and persisted records', async () => {
    const document = await repository.read(filename);
    expect(document).toEqual(originalDocument);
    if (!document) throw new Error('Expected a stored document');
    document.filename = 'mutated';
    document.source = 'mutated';
    expect(await repository.read(filename)).toEqual(originalDocument);
    expect(await repository.read('mutated')).toBeNull();
  });
});

describe('MarkdownSourceRepository: committed raw writes isolated from drafts and queue', () => {
  it.each(sourceCases)('stores $label verbatim, preserving every unrelated record and schema v4', async ({ source }) => {
    const before = await readFixture();
    const document = { filename, source };
    await repository.write(document);
    expect(await readFixture()).toEqual({ ...before, records: {
      ...before.records, markdownDocuments: [otherDocument, document]
    } });
    expect(await new IndexedDbMarkdownSourceRepository(database).read(filename)).toEqual(document);
  });

  it('creates an independent source record under the exact new filename, not its embedded Card ID', async () => {
    const before = await readFixture();
    const document = { filename: 'Заметка #1.md.🗂', source: v1 };
    await repository.write(document);
    expect(await readFixture()).toEqual({ ...before, records: {
      ...before.records, markdownDocuments: [otherDocument, originalDocument, document]
    } });
    expect(await repository.read(document.filename)).toEqual(document);
    expect(await repository.read(v1Card.meta.id)).toBeNull();
  });

  it('captures only contract fields before awaiting, without retaining the caller object', async () => {
    const document = { filename, source: v1, irrelevant: 'must not persist' };
    const saving = repository.write(document);
    document.filename = 'changed';
    document.source = 'changed';
    await saving;
    const stored = await readFixture();
    expect(stored.records.markdownDocuments).toEqual([otherDocument, { filename, source: v1 }]);
    expect(await repository.read('changed')).toBeNull();
  });

  it('survives closing and reopening the owner connection with no schema upgrade', async () => {
    await repository.write({ filename, source: futureV1Shape });
    database.close();
    database = await openFixture();
    expect(await new IndexedDbMarkdownSourceRepository(database).read(filename))
      .toEqual({ filename, source: futureV1Shape });
    expect(database.version).toBe(4);
  });

  it('uses only markdownDocuments on the borrowed connection and leaves ownership to the caller', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const transactions = vi.spyOn(database, 'transaction');
    await repository.write({ filename, source: v1 });
    expect(transactions).toHaveBeenCalledTimes(1);
    const transaction = transactions.mock.results[0].value as IDBTransaction;
    expect([...transaction.objectStoreNames]).toEqual(['markdownDocuments']);
    expect(transaction.mode).toBe('readwrite');
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(await repository.read(filename)).toEqual({ filename, source: v1 });
    expect(transactions).toHaveBeenCalledTimes(2);
    const reading = transactions.mock.results[1].value as IDBTransaction;
    expect([...reading.objectStoreNames]).toEqual(['markdownDocuments']);
    expect(reading.mode).toBe('readonly');
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('MarkdownSourceRepository: storage failures never look like absence or success', () => {
  it.each(['read', 'write'] as const)('rejects %s aborted after request success and preserves previous records', async action => {
    const before = await readFixture();
    const spy = abortAfterRequestSuccess(action);
    const result = action === 'read' ? repository.read(filename) : repository.write({ filename, source: v1 });
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    expect(await readFixture()).toEqual(before);
  });

  it('propagates a quota failure without retrying or replacing the previous source', async () => {
    const before = await readFixture();
    const error = new DOMException('test quota exhausted', 'QuotaExceededError');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw error; });
    await expect(repository.write({ filename, source: v1 })).rejects.toBe(error);
    expect(put).toHaveBeenCalledTimes(1);
    put.mockRestore();
    expect(await readFixture()).toEqual(before);
  });

  it.each(['read', 'write'] as const)('rejects %s on a closed connection without reopening storage', async action => {
    const before = await readFixture();
    database.close();
    const open = vi.spyOn(indexedDB, 'open');
    const result = action === 'read' ? repository.read(filename) : repository.write({ filename, source: v1 });
    await expect(result).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(open).not.toHaveBeenCalled();
    expect(await readFixture()).toEqual(before);
  });

  it.each(['read', 'write'] as const)('rejects %s when the owner did not provide markdownDocuments', async action => {
    const connection = await openFixture('missing-source-store', false);
    const incomplete = new IndexedDbMarkdownSourceRepository(connection);
    const result = action === 'read' ? incomplete.read(filename) : incomplete.write({ filename, source: v1 });
    await expect(result).rejects.toMatchObject({ name: 'NotFoundError' });
    expect([...connection.objectStoreNames]).not.toContain('markdownDocuments');
    expect(connection.version).toBe(4);
  });
});
