import { expect, it, vi } from 'vitest';
import { IndexedDbManualSyncJournal } from '../adapters/indexedDb/manualSyncJournal';
import type { ManualSyncOperation } from '../ports/manualSyncJournal';

const operation: ManualSyncOperation = {
  id: 'first',
  targetKey: 'ctx-a',
  pathKey: 'note.md',
  path: 'Note.md',
  sourceStorageId: 'from',
  targetStorageId: 'to',
  source: '\uFEFFexact\r\n',
  startedAt: 123
};
it('persists exact intent and blocks concurrent duplicate intent across journal instances', async () => {
  const first = new IndexedDbManualSyncJournal();
  const second = new IndexedDbManualSyncJournal();
  const attempts = await Promise.all([
    first.begin(operation),
    second.begin({ ...operation, id: 'second' })
  ]);
  expect([...attempts].sort()).toEqual([false, true]);
  expect(await new IndexedDbManualSyncJournal().list()).toEqual([
    { ...operation, id: attempts[0] ? 'first' : 'second', state: 'processing' }
  ]);
});

it('retains an unknown intent across reload and blocks new writes until explicitly verified', async () => {
  const journal = new IndexedDbManualSyncJournal();
  await journal.begin(operation);
  await journal.settle(operation, 'unknown');
  const reopened = new IndexedDbManualSyncJournal();
  expect(await reopened.list()).toEqual([{ ...operation, state: 'unknown' }]);
  expect(await reopened.begin({ ...operation, id: 'second' })).toBe(false);
});

it('releases a known outcome and never clears another operation with a stale acknowledgement', async () => {
  const journal = new IndexedDbManualSyncJournal();
  await journal.begin(operation);
  await journal.settle(operation, 'known');
  const next = { ...operation, id: 'next' };
  expect(await journal.begin(next)).toBe(true);
  await expect(journal.settle(operation, 'known')).rejects.toThrow();
  expect(await journal.list()).toEqual([{ ...next, state: 'processing' }]);
});

it('keeps equal filenames in different physical contexts independent', async () => {
  const journal = new IndexedDbManualSyncJournal();
  expect(await journal.begin(operation)).toBe(true);
  expect(await journal.begin({ ...operation, targetKey: 'ctx-b' })).toBe(true);
  expect(await journal.list()).toHaveLength(2);
});

it('does not publish durable success after a transaction abort', async () => {
  const journal = new IndexedDbManualSyncJournal();
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = put.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort(), { once: true });
    return request;
  });
  await expect(journal.begin(operation)).rejects.toThrow();
  expect(await journal.list()).toEqual([]);
});

it('archives an explicit dismissal atomically and rejects a stale dismissal of another intent', async () => {
  const journal = new IndexedDbManualSyncJournal();
  await journal.begin(operation);
  await journal.dismiss(operation);
  expect(await journal.list()).toEqual([]);
  expect(await journal.history()).toEqual([
    expect.objectContaining({ id: operation.id, source: operation.source })
  ]);
  const next = { ...operation, id: 'next' };
  await journal.begin(next);
  await expect(journal.dismiss(operation)).rejects.toThrow();
  expect(await journal.list()).toEqual([{ ...next, state: 'processing' }]);
});

it('keeps pending when a dismissal history transaction aborts', async () => {
  const journal = new IndexedDbManualSyncJournal();
  await journal.begin(operation);
  const add = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = add.apply(this, args);
    if (this.name === 'history')
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
    return request;
  });
  await expect(journal.dismiss(operation)).rejects.toThrow();
  expect(await journal.list()).toEqual([{ ...operation, state: 'processing' }]);
  expect(await journal.history()).toEqual([]);
});
