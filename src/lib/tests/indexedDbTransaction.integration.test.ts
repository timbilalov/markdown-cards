// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runIndexedDbTransaction } from '../adapters/indexedDb/transaction';

// Independent scratch schema: this is not the application's future outbox shape.
const databaseName = 'transaction-helper-test';
const original = { id: 'note', source: 'original source', counter: 0 };
const edited = { id: 'note', source: 'edited source', counter: 1 };
const operation = { id: 'op-1', path: 'renamed-note.md', source: edited.source };
let database: IDBDatabase;

async function openFixture(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'id' }).put(original);
      request.result.createObjectStore('operations', { keyPath: 'id' });
      request.result.createObjectStore('unrelated').put('keep', 'key');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Independent oracle, including after rejected transactions: never read through
// the helper under test or another production repository implementation.
async function readFixture() {
  const connection = await openFixture();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = connection.transaction(['drafts', 'operations', 'unrelated'], 'readonly');
      const drafts = transaction.objectStore('drafts').getAll();
      const operations = transaction.objectStore('operations').getAll();
      const unrelated = transaction.objectStore('unrelated').getAll();
      transaction.oncomplete = () => resolve({
        drafts: drafts.result, operations: operations.result, unrelated: unrelated.result
      });
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    connection.close();
  }
}

const initialRecords = { drafts: [original], operations: [], unrelated: ['keep'] };
beforeEach(async () => { database = await openFixture(); });

describe('runIndexedDbTransaction: commit, request lifecycle and borrowed connection', () => {
  it('commits two stores together and fulfils only after complete, never on request success', async () => {
    const events: string[] = [];
    const scopes: string[] = [];
    let isSettled = false;
    const settledAtSuccess: boolean[] = [];
    const saving = runIndexedDbTransaction(database, ['drafts', 'operations'] as const, 'readwrite', transaction => {
      scopes.push(...transaction.objectStoreNames);
      const first = transaction.objectStore('drafts').put(edited);
      const second = transaction.objectStore('operations').put(operation);
      for (const [name, request] of [['draft', first], ['operation', second]] as const) {
        request.addEventListener('success', () => {
          events.push(name);
          settledAtSuccess.push(isSettled);
        });
      }
      // The helper must coexist with callers assigning event-handler properties.
      transaction.oncomplete = () => { events.push('complete'); };
    }).then(() => { isSettled = true; events.push('fulfilled'); });

    await saving;
    expect(await readFixture()).toEqual({ drafts: [edited], operations: [operation], unrelated: ['keep'] });
    expect(events).toEqual(['draft', 'operation', 'complete', 'fulfilled']);
    expect(settledAtSuccess).toEqual([false, false]);
    expect(scopes.sort()).toEqual(['drafts', 'operations']);
  });

  it('allows a readonly request result to be consumed after the transaction completes', async () => {
    const events: string[] = [];
    let value: unknown;
    await runIndexedDbTransaction(database, 'drafts', 'readonly', transaction => {
      const request = transaction.objectStore('drafts').get('note');
      request.onsuccess = () => { value = request.result; events.push('read'); };
      transaction.oncomplete = () => { events.push('complete'); };
    });
    expect(value).toEqual(original);
    expect(events).toEqual(['read', 'complete']);
    expect(await readFixture()).toEqual(initialRecords);
  });

  it('includes requests scheduled from a read success handler in the same committed transaction', async () => {
    const events: string[] = [];
    await runIndexedDbTransaction(database, ['drafts', 'operations'], 'readwrite', transaction => {
      const store = transaction.objectStore('drafts');
      const request = store.get('note');
      request.onsuccess = () => {
        events.push('read');
        store.put({ ...request.result, source: edited.source, counter: request.result.counter + 1 });
        transaction.objectStore('operations').put(operation).onsuccess = () => { events.push('write'); };
      };
      transaction.oncomplete = () => { events.push('complete'); };
    });
    expect(await readFixture()).toEqual({ drafts: [edited], operations: [operation], unrelated: ['keep'] });
    expect(events).toEqual(['read', 'write', 'complete']);
  });

  it('waits for complete even when the callback enqueues no requests', async () => {
    const events: string[] = [];
    await runIndexedDbTransaction(database, 'drafts', 'readonly', transaction => {
      events.push('callback');
      transaction.oncomplete = () => { events.push('complete'); };
    }).then(() => { events.push('fulfilled'); });
    expect(events).toEqual(['callback', 'complete', 'fulfilled']);
  });

  it('uses the supplied open connection once without closing it or opening another database', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const transactions = vi.spyOn(database, 'transaction');
    const enqueue = vi.fn((transaction: IDBTransaction): undefined => {
      transaction.objectStore('drafts').put(edited);
    });
    await runIndexedDbTransaction(database, 'drafts', 'readwrite', enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(transactions).toHaveBeenCalledWith('drafts', 'readwrite');
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(await readFixture()).toEqual({ ...initialRecords, drafts: [edited] });
  });

  it('lets overlapping readwrite transactions observe each preceding committed update', async () => {
    const increment = () => runIndexedDbTransaction(database, 'drafts', 'readwrite', transaction => {
      const store = transaction.objectStore('drafts');
      const request = store.get('note');
      request.onsuccess = () => { store.put({ ...request.result, counter: request.result.counter + 1 }); };
    });
    await Promise.all([increment(), increment()]);
    expect(await readFixture()).toEqual({ ...initialRecords, drafts: [{ ...original, counter: 2 }] });
  });
});

describe('runIndexedDbTransaction: rollback and observable rejection', () => {
  it.each(['before-success', 'after-success'] as const)('rejects explicit abort %s and retains both original stores', async when => {
    const events: string[] = [];
    const saving = runIndexedDbTransaction(database, ['drafts', 'operations'], 'readwrite', transaction => {
      const first = transaction.objectStore('drafts').put(edited);
      transaction.objectStore('operations').put(operation);
      transaction.onabort = () => { events.push('abort'); };
      if (when === 'before-success') transaction.abort();
      else first.onsuccess = () => { transaction.abort(); };
    });
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['abort']);
    expect(await readFixture()).toEqual(initialRecords);
  });

  it('rolls back queued requests before rejecting with the original synchronous callback error', async () => {
    const error = new Error('cannot prepare second record');
    const events: string[] = [];
    const enqueue = vi.fn((transaction: IDBTransaction): undefined => {
      transaction.objectStore('drafts').put(edited);
      transaction.objectStore('operations').put(operation);
      transaction.onabort = () => { events.push('abort'); };
      throw error;
    });
    const saving = runIndexedDbTransaction(database, ['drafts', 'operations'], 'readwrite', enqueue);
    await expect(saving).rejects.toBe(error);
    expect(events).toEqual(['abort']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await readFixture()).toEqual(initialRecords);
  });

  it('rolls back an earlier queued put when the next request throws DataCloneError synchronously', async () => {
    const saving = runIndexedDbTransaction(database, ['drafts', 'operations'], 'readwrite', transaction => {
      transaction.objectStore('drafts').put(edited);
      transaction.objectStore('operations').put({ ...operation, unsupported: () => undefined });
    });
    await expect(saving).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(await readFixture()).toEqual(initialRecords);
  });

  it('propagates asynchronous ConstraintError after rollback without retrying the callback', async () => {
    const events: string[] = [];
    let requestError: unknown;
    const enqueue = vi.fn((transaction: IDBTransaction): undefined => {
      transaction.objectStore('operations').put(operation);
      const duplicate = transaction.objectStore('drafts').add(edited);
      duplicate.onerror = () => { requestError = duplicate.error; events.push('request-error'); };
      transaction.onabort = () => { events.push('abort'); };
    });
    const saving = runIndexedDbTransaction(database, ['drafts', 'operations'], 'readwrite', enqueue);
    await expect(saving).rejects.toMatchObject({ name: 'ConstraintError' });
    await expect(saving).rejects.toBe(requestError);
    expect(events).toEqual(['request-error', 'abort']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await readFixture()).toEqual(initialRecords);
  });

  it('allows an explicitly handled request error to recover and commit instead of rejecting early', async () => {
    const events: string[] = [];
    await runIndexedDbTransaction(database, ['drafts', 'operations'], 'readwrite', transaction => {
      transaction.objectStore('operations').put(operation);
      const store = transaction.objectStore('drafts');
      const duplicate = store.add(edited);
      duplicate.onerror = event => {
        event.preventDefault();
        events.push('handled-error');
        store.put(edited);
      };
      transaction.oncomplete = () => { events.push('complete'); };
    });
    expect(await readFixture()).toEqual({ drafts: [edited], operations: [operation], unrelated: ['keep'] });
    expect(events).toEqual(['handled-error', 'complete']);
  });

  it('rejects writes in a readonly transaction without changing stored data', async () => {
    await expect(runIndexedDbTransaction(database, 'drafts', 'readonly', transaction => {
      transaction.objectStore('drafts').put(edited);
    })).rejects.toMatchObject({ name: 'ReadOnlyError' });
    expect(await readFixture()).toEqual(initialRecords);
  });

  it.each([
    { name: 'missing store', stores: ['missing'], error: 'NotFoundError' },
    { name: 'empty scope', stores: [], error: 'InvalidAccessError' }
  ])('rejects transaction creation for $name before invoking the callback', async ({ stores, error }) => {
    const enqueue = vi.fn((): undefined => undefined);
    await expect(runIndexedDbTransaction(database, stores, 'readwrite', enqueue))
      .rejects.toMatchObject({ name: error });
    expect(enqueue).not.toHaveBeenCalled();
    expect(await readFixture()).toEqual(initialRecords);
  });

  it('rejects a closed connection rather than reopening it or silently succeeding', async () => {
    database.close();
    const enqueue = vi.fn((): undefined => undefined);
    const open = vi.spyOn(indexedDB, 'open');
    await expect(runIndexedDbTransaction(database, 'drafts', 'readonly', enqueue))
      .rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await readFixture()).toEqual(initialRecords);
  });
});
