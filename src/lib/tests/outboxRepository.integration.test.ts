import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbOutboxRepository } from '../adapters/indexedDb/outboxRepository';
import type { OutboxOperation, OutboxState } from '../domain/outbox';
import type { OutboxEvent, OutboxRepository } from '../ports/outboxRepository';
import { legacyRecords } from './helpers/legacyDatabase';
import { v1 } from './helpers/markdownReadFixtures';

const NOW = 10_000;
const filename = 'Архив.md.🗂';
const source = (v1 + '\n\n').replaceAll('\n', '\r\n');
const policy = { baseDelayMs: 1000, maxDelayMs: 5000 };
const states: OutboxState[] = [
  { status: 'pending', nextAttemptAt: 100 },
  { status: 'processing', deliveryId: 'delivery-A', startedAt: 200 },
  { status: 'failed', reason: 'network', nextAttemptAt: NOW + 1000 },
  { status: 'uncertain', deliveryId: 'interrupted-D', reason: 'interrupted' },
  { status: 'conflict' },
  { status: 'completed', revision: 'completed-revision', completedAt: 500 },
  { status: 'failed', reason: 'auth', nextAttemptAt: null }
];
const operations: OutboxOperation[] = states.map((state, i) => ({
  id: `op-${i}`, cardId: 'test-card', path: i === 0 ? `${filename}.md` : `archive-${i}.md`,
  source, createOnly: i === 0, base: i === 0 ? { kind: 'missing' } : { kind: 'present', revision: ' base/1 ' },
  createdAt: NOW - i, attempts: i, state
}));
const added: OutboxOperation = { ...operations[0], id: 'new-save' };
const start: OutboxEvent = { type: 'start', deliveryId: 'delivery-B', now: NOW };
const finish: OutboxEvent = {
  type: 'finish', deliveryId: 'delivery-A', now: NOW,
  outcome: { status: 'written', revision: 'new-revision' }, policy
};
const actions = ['read', 'list', 'add', 'apply'] as const;
type Action = typeof actions[number];
let database: IDBDatabase;
let repository: OutboxRepository;

// A proposed physical v5 fixture, independent of DBService and the repository.
// This does NOT test or perform an upgrade of the application's deployed v4.
async function openFixture(name = 'OutboxRepositoryTestDB', includeOutbox = true): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      const cards = db.createObjectStore('cards', { keyPath: 'meta.id' });
      cards.createIndex('title', 'meta.title');
      cards.createIndex('modified', 'meta.modified');
      for (const record of legacyRecords.cards) cards.put(record);
      const files = db.createObjectStore('files', { keyPath: 'path' });
      files.createIndex('name', 'name');
      files.createIndex('modified', 'modified');
      for (const record of legacyRecords.files) files.put(record);
      const queue = db.createObjectStore('syncQueue', { keyPath: 'id' });
      queue.createIndex('timestamp', 'timestamp');
      queue.createIndex('status', 'status');
      for (const record of legacyRecords.syncQueue) queue.put(record);
      db.createObjectStore('markdownDocuments', { keyPath: 'filename' }).put({ filename, source: v1 });
      db.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' })
        .put({ filename, source, saveMode: 'update' });
      if (includeOutbox) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        // Reverse insertion and creation-time order relative to primary keys.
        for (const operation of [...operations].reverse()) outbox.add(operation);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredState() {
  const db = await openFixture();
  try {
    return await new Promise<{ version: number; records: Record<string, unknown[]> }>((resolve, reject) => {
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readonly');
      const requests = names.map(name => [name, tx.objectStore(name).getAll()] as const);
      tx.oncomplete = () => resolve({ version: db.version,
        records: Object.fromEntries(requests.map(([name, request]) => [name, request.result])) });
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function replaceOperation(index: number, updated: OutboxOperation) {
  return operations.map((op, i) => i === index ? updated : op);
}

function perform(action: Action, target: OutboxRepository = repository) {
  switch (action) {
    case 'read': return target.read('op-0');
    case 'list': return target.list();
    case 'add': return target.add(added);
    case 'apply': return target.apply('op-0', start);
  }
}

const method = { read: 'get', list: 'getAll', add: 'add', apply: 'put' } as const;
function abortAfterRequestSuccess(action: Action) {
  const original = IDBObjectStore.prototype[method[action]];
  return vi.spyOn(IDBObjectStore.prototype, method[action]).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    const request = Reflect.apply(original, this, args) as IDBRequest;
    if (this.name === 'outbox') request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
}

beforeEach(async () => {
  database = await openFixture();
  repository = new IndexedDbOutboxRepository(database);
});

describe('OutboxRepository: complete operation storage separate from legacy data', () => {
  it('reads the exact operation by Save ID, preserving source, base, path, intent and counters', async () => {
    const before = await readStoredState();
    expect(await repository.read('op-0')).toEqual(operations[0]);
    expect(await readStoredState()).toEqual(before);
  });

  it('returns null for an absent ID, Card ID, path or legacy queue ID', async () => {
    for (const id of ['missing', 'test-card', operations[0].path, 'operation-pending']) {
      expect(await repository.read(id)).toBeNull();
    }
  });

  it('lists every state by primary key, including blocked, uncertain and completed operations', async () => {
    const before = await readStoredState();
    expect(await repository.list()).toEqual(operations);
    expect(await readStoredState()).toEqual(before);
  });

  it('returns an empty list without fabricating operations from existing legacy queue or snapshots', async () => {
    const tx = database.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const before = await readStoredState();
    expect(await repository.list()).toEqual([]);
    expect(await repository.read('operation-pending')).toBeNull();
    expect(await readStoredState()).toEqual(before);
  });

  it('isolates nested read/list results from each other and persisted data', async () => {
    const read = await repository.read('op-1');
    const list = await repository.list();
    expect(read).toEqual(operations[1]);
    expect(list).toEqual(operations);
    if (!read) throw new Error('Expected operation');
    if (read.base.kind === 'present') read.base.revision = 'changed';
    if (read.state.status === 'processing') read.state.deliveryId = 'changed';
    list[1].source = 'changed';
    list[1].state = { status: 'conflict' };
    expect(await repository.read('op-1')).toEqual(operations[1]);
    expect(await repository.list()).toEqual(operations);
  });

  it.each(states)('adds a complete $status operation without changing any existing store or record', async state => {
    const before = await readStoredState();
    const input = { ...added, state };
    await repository.add(input);
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, outbox: [input, ...operations]
    } });
  });

  it('captures nested add input before its first await', async () => {
    const input = structuredClone({ ...operations[1], id: added.id });
    const expected = structuredClone(input);
    const before = await readStoredState();
    const writing = repository.add(input);
    input.id = 'changed';
    input.source = 'changed';
    if (input.base.kind === 'present') input.base.revision = 'changed';
    if (input.state.status === 'processing') input.state.deliveryId = 'changed';
    await writing;
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, outbox: [expected, ...operations]
    } });
  });

  it.each(['equal', 'different'] as const)('rejects a duplicate ID with %s data instead of overwriting', async kind => {
    const before = await readStoredState();
    const input = structuredClone(operations[1]);
    if (kind === 'different') input.source = source.replace('# Карточка 🗂', '# Another Save');
    await expect(repository.add(input)).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readStoredState()).toEqual(before);
  });

  it('persists an added operation across an owner reconnect', async () => {
    await repository.add(added);
    database.close();
    database = await openFixture();
    expect(await new IndexedDbOutboxRepository(database).read(added.id)).toEqual(added);
  });
});

describe('OutboxRepository: atomically apply the lifecycle to the current stored state', () => {
  const appliedCases: { label: string; index: number; event: OutboxEvent; state: OutboxState; attempts: number }[] = [
    { label: 'start', index: 0, event: start,
      state: { status: 'processing', deliveryId: 'delivery-B', startedAt: NOW }, attempts: 0 },
    { label: 'written', index: 1, event: finish,
      state: { status: 'completed', revision: 'new-revision', completedAt: NOW }, attempts: 1 },
    { label: 'retry', index: 1, event: { ...finish, outcome: { status: 'failed', reason: 'network', outcome: 'not-written' } },
      state: { status: 'failed', reason: 'network', nextAttemptAt: NOW + 2000 }, attempts: 2 },
    { label: 'blocked', index: 1, event: { ...finish, outcome: { status: 'failed', reason: 'auth', outcome: 'not-written' } },
      state: { status: 'failed', reason: 'auth', nextAttemptAt: null }, attempts: 2 },
    { label: 'uncertain', index: 1, event: { ...finish, outcome: { status: 'failed', reason: 'remote', outcome: 'unknown' } },
      state: { status: 'uncertain', deliveryId: 'delivery-A', reason: 'remote' }, attempts: 2 },
    { label: 'conflict', index: 1, event: { ...finish, outcome: { status: 'conflict' } },
      state: { status: 'conflict' }, attempts: 2 },
    { label: 'recovery', index: 1, event: { type: 'recover' },
      state: { status: 'uncertain', deliveryId: 'delivery-A', reason: 'interrupted' }, attempts: 1 }
  ];

  it.each(appliedCases)('commits $label and preserves every unrelated record', async ({ index, event, state, attempts }) => {
    const before = await readStoredState();
    const updated = { ...operations[index], state, attempts };
    const result = await repository.apply(updated.id, event);
    expect(result).toEqual({ status: 'changed', operation: updated });
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, outbox: replaceOperation(index, updated)
    } });
    if (result.status !== 'changed') throw new Error('Expected persisted transition');
    result.operation.source = 'changed';
    result.operation.state = { status: 'conflict' };
    expect(await repository.read(updated.id)).toEqual(updated);
  });

  it.each([
    { id: 'op-2', event: start, reason: 'not-due' },
    { id: 'op-6', event: start, reason: 'retry-blocked' },
    { id: 'op-5', event: start, reason: 'invalid-state' },
    { id: 'op-1', event: { ...finish, deliveryId: 'old-delivery' }, reason: 'stale-delivery' }
  ])('returns ignored/$reason without persisting a change', async ({ id, event, reason }) => {
    const before = await readStoredState();
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    expect(await repository.apply(id, event)).toEqual({ status: 'ignored', reason });
    expect(put).not.toHaveBeenCalled();
    expect(await readStoredState()).toEqual(before);
  });

  it('returns missing only after reading an absent ID and does not create it', async () => {
    const before = await readStoredState();
    expect(await repository.apply('missing', start)).toEqual({ status: 'missing' });
    expect(await readStoredState()).toEqual(before);
  });

  it('captures a start event before asynchronous storage reads', async () => {
    const event = { type: 'start', deliveryId: 'delivery-B', now: NOW } as const;
    const input: OutboxEvent = { ...event };
    const applying = repository.apply('op-0', input);
    input.deliveryId = 'changed';
    input.now = 1;
    const updated = { ...operations[0], state: {
      status: 'processing' as const, deliveryId: event.deliveryId, startedAt: event.now
    } };
    expect(await applying).toEqual({ status: 'changed', operation: updated });
    expect((await readStoredState()).records.outbox).toEqual(replaceOperation(0, updated));
  });

  it('captures nested finish outcome and retry policy before asynchronous storage reads', async () => {
    const input: OutboxEvent = {
      type: 'finish', deliveryId: 'delivery-A', now: NOW,
      outcome: { status: 'failed', reason: 'network', outcome: 'not-written' }, policy: { ...policy }
    };
    const applying = repository.apply('op-1', input);
    input.policy.baseDelayMs = 1;
    input.policy.maxDelayMs = 1;
    if (input.outcome.status === 'failed') input.outcome.reason = 'auth';
    const updated = { ...operations[1], attempts: 2, state: {
      status: 'failed' as const, reason: 'network' as const, nextAttemptAt: NOW + 2000
    } };
    expect(await applying).toEqual({ status: 'changed', operation: updated });
    expect((await readStoredState()).records.outbox).toEqual(replaceOperation(1, updated));
  });
});

describe('OutboxRepository: competing connections cannot apply a transition twice', () => {
  it('allows only one of two concurrent additions of the same ID', async () => {
    const before = await readStoredState();
    const other = new IndexedDbOutboxRepository(await openFixture());
    const candidates = [added, { ...added, path: 'other-path.md' }];
    const results = await Promise.allSettled([repository.add(candidates[0]), other.add(candidates[1])]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const loser = results.find(result => result.status === 'rejected');
    expect(loser).toMatchObject({ reason: { name: 'ConstraintError' } });
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, outbox: [candidates[winner], ...operations]
    } });
  });

  it('claims a pending operation once when two connections start delivery concurrently', async () => {
    const before = await readStoredState();
    const other = new IndexedDbOutboxRepository(await openFixture());
    const results = await Promise.all([
      repository.apply('op-0', start), other.apply('op-0', { ...start, deliveryId: 'delivery-C' })
    ]);
    expect(results.map(result => result?.status).sort()).toEqual(['changed', 'ignored']);
    const winner = results.findIndex(result => result.status === 'changed');
    const updated = { ...operations[0], state: {
      status: 'processing' as const, deliveryId: winner === 0 ? 'delivery-B' : 'delivery-C', startedAt: NOW
    } };
    expect(results[winner]).toEqual({ status: 'changed', operation: updated });
    expect(results[1 - winner]).toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, outbox: replaceOperation(0, updated)
    } });
  });

  it('counts a concurrent duplicate failure once and leaves a late success ignored', async () => {
    const before = await readStoredState();
    const other = new IndexedDbOutboxRepository(await openFixture());
    const event: OutboxEvent = { ...finish, outcome: { status: 'failed', reason: 'network', outcome: 'not-written' } };
    const results = await Promise.all([repository.apply('op-1', event), other.apply('op-1', event)]);
    expect(results.map(result => result?.status).sort()).toEqual(['changed', 'ignored']);
    const updated = { ...operations[1], attempts: 2, state: {
      status: 'failed' as const, reason: 'network' as const, nextAttemptAt: NOW + 2000
    } };
    expect(results).toContainEqual({ status: 'changed', operation: updated });
    expect(results).toContainEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(await repository.apply('op-1', finish)).toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(await readStoredState()).toEqual({ ...before, records: {
      ...before.records, outbox: replaceOperation(1, updated)
    } });
  });
});

describe('OutboxRepository: transaction boundaries, ownership and errors', () => {
  it('uses only outbox transactions and leaves opening/schema/closing to the owner', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const transactions = vi.spyOn(database, 'transaction');
    expect(await repository.read('op-0')).toEqual(operations[0]);
    expect(await repository.list()).toEqual(operations);
    await repository.add(added);
    expect(await repository.apply('op-0', start)).toMatchObject({ status: 'changed' });
    expect(transactions.mock.results.map(result => {
      const tx: IDBTransaction = result.value;
      return { stores: [...tx.objectStoreNames], mode: tx.mode };
    })).toEqual(['readonly', 'readonly', 'readwrite', 'readwrite']
      .map(mode => ({ stores: ['outbox'], mode })));
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects %s aborted after request success and rolls back all data', async action => {
    const before = await readStoredState();
    const spy = abortAfterRequestSuccess(action);
    await expect(perform(action)).rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    expect(await readStoredState()).toEqual(before);
    if (action === 'apply') {
      expect(await repository.apply('op-0', start)).toMatchObject({ status: 'changed' });
    }
  });

  it.each(['missing', 'ignored'] as const)('rejects an aborted %s apply instead of returning a business result', async kind => {
    const before = await readStoredState();
    const spy = abortAfterRequestSuccess('read');
    await expect(repository.apply(kind === 'missing' ? 'missing' : 'op-5', start))
      .rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    expect(await readStoredState()).toEqual(before);
  });

  it.each(actions)('propagates the original synchronous %s request failure once', async action => {
    const before = await readStoredState();
    const error = new DOMException('Outbox request failed', 'QuotaExceededError');
    const spy = vi.spyOn(IDBObjectStore.prototype, method[action]).mockImplementation(() => { throw error; });
    await expect(perform(action)).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await readStoredState()).toEqual(before);
  });

  it('rolls back a transition after an asynchronous put failure with the original request error', async () => {
    const before = await readStoredState();
    const captured: { error: DOMException | null } = { error: null };
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value) {
      const request = this.add(value); // The operation already exists: native ConstraintError.
      request.addEventListener('error', () => { captured.error = request.error; });
      return request;
    });
    const result = await repository.apply('op-0', start).then(
      value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error })
    );
    expect(result).toMatchObject({ status: 'rejected', error: { name: 'ConstraintError' } });
    expect(captured.error).not.toBeNull();
    expect(result).toEqual({ status: 'rejected', error: captured.error });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await readStoredState()).toEqual(before);
  });

  it.each(actions)('rejects %s on a closed connection without reopening storage', async action => {
    const before = await readStoredState();
    database.close();
    const open = vi.spyOn(indexedDB, 'open');
    await expect(perform(action)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(open).not.toHaveBeenCalled();
    expect(await readStoredState()).toEqual(before);
  });

  it.each(actions)('rejects %s without an outbox store instead of repairing or treating it as empty', async action => {
    const db = await openFixture('MissingOutboxTestDB', false);
    await expect(perform(action, new IndexedDbOutboxRepository(db))).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(db.version).toBe(5);
    expect([...db.objectStoreNames]).not.toContain('outbox');
  });
});
