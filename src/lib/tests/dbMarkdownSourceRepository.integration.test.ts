import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { DBService, DBTransactionError } from '../services/dbService';
import { seedLegacyDatabase } from './helpers/legacyDatabase';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const filename = 'archive.md.Заметка'; // Independent of the embedded Card ID.
const originalSource = { filename, source: legacy.replaceAll('\n', '\r\n') };
const pendingSnapshot = { filename, source: v1, saveMode: 'update' };
let connection: IDBDatabase;
let service: DBService;

beforeEach(async () => {
  // Create physical v4 records independently of DBService and its repositories.
  // Retain all four legacy queue statuses alongside downloaded and pending data.
  await seedLegacyDatabase();
  connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB', 4);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('markdownDocuments', { keyPath: 'filename' }).put(originalSource);
      request.result.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' }).put(pendingSnapshot);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Release the physical v4 seed connection before the facade upgrades it.
  connection.close();
  service = new DBService();
  await service.init();
  connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  service.resetPerformanceMetrics();
});

// Inspect all persisted stores through raw IndexedDB, not through the facade
// whose error handling is under test. Setup closes every connection after a test.
async function readStoredState() {
  return new Promise<{ version: number; records: Record<string, unknown[]> }>((resolve, reject) => {
    const transaction = connection.transaction([...connection.objectStoreNames], 'readonly');
    const requests = [...transaction.objectStoreNames].map(name =>
      [name, transaction.objectStore(name).getAll()] as const);
    transaction.oncomplete = () => resolve({
      version: connection.version,
      records: Object.fromEntries(requests.map(([name, request]) => [name, request.result]))
    });
    transaction.onabort = () => reject(transaction.error);
  });
}

describe('DBService source cache: transaction errors at the repository boundary', () => {
  it.each(['read', 'write'] as const)('reports a synchronous %s failure as DBTransactionError, preserving data and explicit retry', async action => {
    const before = await readStoredState();
    const storageError = action === 'read'
      ? new DOMException('The source read transaction is inactive', 'TransactionInactiveError')
      : new DOMException('The source cache quota is exhausted', 'QuotaExceededError');
    const request = vi.spyOn(IDBObjectStore.prototype, action === 'read' ? 'get' : 'put')
      .mockImplementation(() => { throw storageError; });

    const operation = action === 'read'
      ? service.getMarkdownDocument(filename)
      : service.saveMarkdownDocument(filename, v1);
    const failure: unknown = await operation.then(() => null, (error: unknown) => error);
    expect(request).toHaveBeenCalledTimes(1); // No automatic retry of a storage failure.
    request.mockRestore();
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1 });
    expect(await readStoredState()).toEqual(before);
    expect(failure).toBeInstanceOf(DBTransactionError);
    expect(failure).toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(failure).toHaveProperty('message', expect.stringContaining(storageError.message));

    // The caller can explicitly retry with the same connection and filename.
    // Neither a failed read nor a failed download-cache write consumes a draft.
    if (action === 'read') {
      expect(await service.getMarkdownDocument(filename)).toEqual({
        filename, result: { status: 'unsupported', source: originalSource.source, reason: 'missing-version' }
      });
      expect(await readStoredState()).toEqual(before);
    } else {
      await service.saveMarkdownDocument(filename, v1);
      expect(await readStoredState()).toEqual({ ...before, records: {
        ...before.records, markdownDocuments: [{ filename, source: v1 }]
      } });
      expect(await service.getMarkdownDocument(filename)).toEqual({
        filename, result: { status: 'success', document: { version: 1, source: v1, card: v1Card } }
      });
    }
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: action === 'read' ? 1 : 2, errors: 1 });
  });
});
