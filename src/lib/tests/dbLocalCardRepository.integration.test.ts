import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { DBService, DBTransactionError } from '../services/dbService';
import { legacyRecords, seedLegacyDatabase } from './helpers/legacyDatabase';
import { makeCard, storedCard } from './helpers/fixtures';
import { v1 } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const original = legacyRecords.cards[0];
const other = storedCard(makeCard({ meta: { ...original.meta, id: 'z-card' } }));
const changed = makeCard({ title: 'Changed 🗂', meta: { ...original.meta, modified: original.meta.modified + 1 } });
const filename = 'archive.md.Заметка';
const actions = ['saveCard', 'getCard', 'getAllCards', 'deleteCard'] as const;
type Action = typeof actions[number];
const methods = { saveCard: 'put', getCard: 'get', getAllCards: 'getAll', deleteCard: 'delete' } as const;
let connection: IDBDatabase;
let service: DBService;

beforeEach(async () => {
  // Physical fixture independent of the facade/repository under test.
  await seedLegacyDatabase();
  connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB', 4);
    request.onupgradeneeded = () => {
      request.transaction!.objectStore('cards').put(other);
      request.result.createObjectStore('markdownDocuments', { keyPath: 'filename' }).put({ filename, source: legacy });
      request.result.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' })
        .put({ filename, source: v1, saveMode: 'update' });
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
  // Only retry delays are virtual. fake-indexeddb's native setImmediate tasks
  // still run, so the RED observes final assertions rather than waiting 7 seconds.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

async function readStoredState() {
  return new Promise<{ version: number; records: Record<string, unknown[]> }>((resolve, reject) => {
    const transaction = connection.transaction([...connection.objectStoreNames], 'readonly');
    const requests = [...transaction.objectStoreNames].map(name =>
      [name, transaction.objectStore(name).getAll()] as const);
    transaction.oncomplete = () => resolve({ version: connection.version,
      records: Object.fromEntries(requests.map(([name, request]) => [name, request.result]))
    });
    transaction.onabort = () => reject(transaction.error);
  });
}

function perform(action: Action) {
  switch (action) {
    case 'saveCard': return service.saveCard(changed);
    case 'getCard': return service.getCard(original.meta.id);
    case 'getAllCards': return service.getAllCards();
    case 'deleteCard': return service.deleteCard(original.meta.id);
  }
}

async function settle(operation: ReturnType<typeof perform>) {
  const result = operation.then(
    value => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  );
  await vi.advanceTimersByTimeAsync(8000);
  return result;
}

function abortAfterSuccess(action: Action) {
  const native = IDBObjectStore.prototype[methods[action]];
  return vi.spyOn(IDBObjectStore.prototype, methods[action]).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    const request = Reflect.apply(native, this, args) as IDBRequest;
    if (this.name === 'cards') request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
}

async function expectExplicitRetry(action: Action, before: Awaited<ReturnType<typeof readStoredState>>) {
  service.resetPerformanceMetrics();
  const value = await perform(action);
  if (action === 'getCard') expect(value).toEqual(original);
  else if (action === 'getAllCards') expect(value).toEqual([original, other]);
  else expect(value).toBeUndefined();
  const cards = action === 'saveCard' ? [storedCard(changed), other]
    : action === 'deleteCard' ? [other] : [original, other];
  expect(await readStoredState()).toEqual({ ...before, records: { ...before.records, cards } });
  expect(service.getPerformanceMetrics()).toMatchObject({ operations: 1, errors: 0 });
}

describe('DBService Card repository adoption: commit-aware public operations', () => {
  it.each(actions)('%s rejects an abort after request success, retains every store and permits explicit retry', async action => {
    const before = await readStoredState();
    const spy = abortAfterSuccess(action);
    const outcome = await settle(perform(action));
    expect(outcome).toMatchObject({ status: 'rejected', error: expect.any(DBTransactionError) });
    expect(outcome).toMatchObject({ error: { code: 'TRANSACTION_FAILED' } });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1, errorRate: 0 });
    expect(await readStoredState()).toEqual(before);
    await expectExplicitRetry(action, before);
  });

  it.each(actions)('%s reports synchronous storage failure once as DBTransactionError without automatic retry', async action => {
    const before = await readStoredState();
    const storageError = new DOMException(`Failure in ${action}`, action === 'saveCard' ? 'QuotaExceededError' : 'TransactionInactiveError');
    const spy = vi.spyOn(IDBObjectStore.prototype, methods[action]).mockImplementation(() => { throw storageError; });
    const outcome = await settle(perform(action));
    expect(outcome).toMatchObject({ status: 'rejected', error: expect.any(DBTransactionError) });
    expect(outcome).toMatchObject({ error: { code: 'TRANSACTION_FAILED', message: expect.stringContaining(storageError.message) } });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1, errorRate: 0 });
    expect(await readStoredState()).toEqual(before);
    await expectExplicitRetry(action, before);
  });

  it('counts one asynchronous request failure once, retaining its diagnostic and all data', async () => {
    const before = await readStoredState();
    const captured: { error: DOMException | null } = { error: null };
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value) {
      const request = this.add(value); // Existing primary key causes a native async ConstraintError.
      request.addEventListener('error', () => { captured.error = request.error; });
      return request;
    });
    const outcome = await settle(service.saveCard(changed));
    expect(captured.error).toMatchObject({ name: 'ConstraintError' });
    if (!captured.error) throw new Error('Expected the native request error');
    expect(outcome).toMatchObject({ status: 'rejected', error: expect.any(DBTransactionError) });
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 0, errors: 1, errorRate: 0 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ error: { message: expect.stringContaining(captured.error.message) } });
    put.mockRestore();
    expect(await readStoredState()).toEqual(before);
    await expectExplicitRetry('saveCard', before);
  });

  it('captures the exact Card before the first await, even while the caller continues editing', async () => {
    const before = await readStoredState();
    const input = structuredClone(changed);
    const saving = service.saveCard(input);
    input.meta.id = 'mutated';
    input.meta.modified += 500;
    input.title = 'mutated';
    input.tags?.push('mutated');
    input.sections[0].items[0].text = 'mutated';
    await saving;
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, cards: [storedCard(changed), other]
    } });
    expect(service.getPerformanceMetrics()).toMatchObject({ operations: 1, errors: 0 });
  });
});
