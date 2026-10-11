import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbCardSaveRepository } from '../adapters/indexedDb/cardSaveRepository';
import type {
  CardSaveDelivery, CardSaveDeliveryResult, CardSaveDraft, SavedMarkdownDraft
} from '../ports/cardSaveRepository';
import type { OutboxOperation, OutboxState } from '../domain/outbox';
import { legacyRecords } from './helpers/legacyDatabase';
import { storedCard } from './helpers/fixtures';
import { v1, v1Card, futureV1Shape } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const databaseName = 'CardSaveDeliveryTestDB';
const filename = 'Архив.md.🗂';
const source = (v1 + '\n\n').replaceAll('\n', '\r\n');
const operation: OutboxOperation = {
  id: 'save-current', cardId: v1Card.meta.id, path: `${filename}.md`, source,
  createOnly: false, base: { kind: 'present', revision: ' opaque/base ' },
  createdAt: 10_000, attempts: 2,
  state: { status: 'processing', deliveryId: 'delivery-A', startedAt: 12_000 }
};
const currentDraft: SavedMarkdownDraft = { filename, source, saveMode: 'update', saveId: operation.id };
const delivery: CardSaveDelivery = {
  deliveryId: 'delivery-A', now: 20_000,
  outcome: { status: 'written', revision: ' remote/revision ' },
  policy: { baseDelayMs: 1000, maxDelayMs: 5000 }
};
const inactiveStates: OutboxState[] = [
  { status: 'pending', nextAttemptAt: 100 },
  { status: 'failed', reason: 'network', nextAttemptAt: 9000 },
  { status: 'failed', reason: 'auth', nextAttemptAt: null },
  { status: 'uncertain', deliveryId: 'delivery-A', reason: 'interrupted' },
  { status: 'conflict' },
  { status: 'completed', revision: 'previous-success', completedAt: 500 }
];
const history = inactiveStates.map((state, i): OutboxOperation => ({
  ...operation, id: `history-${i}`, path: `history-${i}.md`, state
}));
const stores = ['localMarkdownSnapshots', 'markdownDocuments', 'outbox'] as const;
type Store = typeof stores[number];
type State = { version: number; records: Record<string, unknown[]> };
type DraftResult = Extract<CardSaveDeliveryResult, { status: 'changed' }>['draft'];
let database: IDBDatabase;
let repository: IndexedDbCardSaveRepository;

// Independent physical v5 fixture. Card intentionally differs from the operation
// to catch an acknowledgement that overwrites a newer local projection.
function openFixture(name = databaseName, omitted?: Store): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      const cards = db.createObjectStore('cards', { keyPath: 'meta.id' });
      cards.createIndex('title', 'meta.title');
      cards.createIndex('modified', 'meta.modified');
      cards.put(storedCard({ ...v1Card, title: 'Newer local projection' }));
      const files = db.createObjectStore('files', { keyPath: 'path' });
      for (const file of legacyRecords.files) files.put(file);
      const queue = db.createObjectStore('syncQueue', { keyPath: 'id' });
      for (const row of legacyRecords.syncQueue) queue.put(row);
      if (omitted !== 'markdownDocuments') {
        const documents = db.createObjectStore('markdownDocuments', { keyPath: 'filename' });
        documents.put({ filename, source: futureV1Shape });
        documents.put({ filename: 'legacy-source', source: legacy });
      }
      if (omitted !== 'localMarkdownSnapshots') {
        const drafts = db.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' });
        drafts.put(currentDraft);
        drafts.put({ filename: 'other.md.note', source: v1, saveMode: 'create' });
      }
      if (omitted !== 'outbox') {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.add(operation);
        for (const row of history) outbox.add(row);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readState(name = databaseName): Promise<State> {
  const db = await openFixture(name);
  try {
    return await new Promise((resolve, reject) => {
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readonly');
      const requests = names.map(name => tx.objectStore(name).getAll());
      tx.oncomplete = () => resolve({ version: db.version,
        records: Object.fromEntries(names.map((name, i) => [name, requests[i].result])) });
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function putRow(store: Store, row: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite');
    tx.objectStore(store).put(row);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

function deleteDraft(): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('localMarkdownSnapshots', 'readwrite');
    tx.objectStore('localMarkdownSnapshots').delete(filename);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

function completed(row = operation, revision: string | null = ' remote/revision ', now = delivery.now): OutboxOperation {
  return { ...row, state: { status: 'completed', revision, completedAt: now } };
}

function changed(row: OutboxOperation, draft: DraftResult): CardSaveDeliveryResult {
  return { status: 'changed', operation: row, draft };
}

function upsert<T>(rows: T[], row: T, key: (row: T) => string): T[] {
  return [...rows.filter(value => key(value) !== key(row)), row]
    .sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

// Golden state changes do not call production lifecycle/repository helpers.
function expectedState(before: State, row: OutboxOperation, draft: DraftResult): State {
  const records: State['records'] = {
    ...before.records, outbox: upsert(before.records.outbox as OutboxOperation[], row, row => row.id)
  };
  if (draft === 'confirmed') {
    const name = row.path.slice(0, -3);
    records.localMarkdownSnapshots = (before.records.localMarkdownSnapshots as SavedMarkdownDraft[])
      .filter(snapshot => snapshot.filename !== name);
    records.markdownDocuments = upsert(before.records.markdownDocuments as { filename: string; source: string }[],
      { filename: name, source: row.source }, document => document.filename);
  }
  return { ...before, records };
}

const sites = [
  { label: 'operation read', store: 'outbox', method: 'get' },
  { label: 'draft read', store: 'localMarkdownSnapshots', method: 'get' },
  { label: 'operation write', store: 'outbox', method: 'put' },
  { label: 'source write', store: 'markdownDocuments', method: 'put' },
  { label: 'draft removal', store: 'localMarkdownSnapshots', method: 'delete' }
] as const;

function intercept(site: typeof sites[number], effect: (store: IDBObjectStore, enqueue: () => IDBRequest) => IDBRequest) {
  const original = IDBObjectStore.prototype[site.method];
  return vi.spyOn(IDBObjectStore.prototype, site.method).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    const enqueue = () => Reflect.apply(original, this, args) as IDBRequest;
    return this.name === site.store ? effect(this, enqueue) : enqueue();
  });
}

beforeEach(async () => {
  database = await openFixture();
  repository = new IndexedDbCardSaveRepository(database);
});

describe('CardSaveRepository: acknowledge exactly the delivered Save', () => {
  it.each([
    { createOnly: false, revision: ' opaque/revision ' }, { createOnly: false, revision: null },
    { createOnly: true, revision: ' opaque/revision ' }, { createOnly: true, revision: null }
  ])('atomically completes and acknowledges createOnly=$createOnly with revision=$revision', async ({ createOnly, revision }) => {
    const row: OutboxOperation = { ...operation, createOnly, base: createOnly ? { kind: 'missing' } : operation.base };
    await putRow('outbox', row);
    await putRow('localMarkdownSnapshots', { ...currentDraft, saveMode: createOnly ? 'create' : 'update' });
    const before = await readState();
    const event: CardSaveDelivery = { ...delivery, outcome: { status: 'written', revision } };
    const expected = completed(row, revision);
    expect(await repository.finishDelivery(row.id, event)).toEqual(changed(expected, 'confirmed'));
    expect(await readState()).toEqual(expectedState(before, expected, 'confirmed'));
  });

  it.each([
    { label: 'newer ID with identical source', row: { ...currentDraft, saveId: 'newer-save' } },
    { label: 'newer ID with different source', row: { ...currentDraft, saveId: 'newer-save', source: source + '\n' } },
    { label: 'legacy draft without Save ID', row: { filename, source, saveMode: 'update' } },
    { label: 'different source for the same ID', row: { ...currentDraft, source: source + '\n' } },
    { label: 'different mode for the same ID', row: { ...currentDraft, saveMode: 'create' } }
  ])('completes the operation but preserves a $label and the entire remote cache', async ({ row }) => {
    await putRow('localMarkdownSnapshots', row);
    const before = await readState();
    expect(await repository.finishDelivery(operation.id, delivery)).toEqual(changed(completed(), 'superseded'));
    expect(await readState()).toEqual(expectedState(before, completed(), 'superseded'));
  });

  it('completes a delivery with no current draft without replacing a possibly newer remote cache', async () => {
    await deleteDraft();
    const before = await readState();
    expect(await repository.finishDelivery(operation.id, delivery)).toEqual(changed(completed(), 'missing'));
    expect(await readState()).toEqual(expectedState(before, completed(), 'missing'));
  });

  it('returns missing only for an absent Save ID without matching by Card ID or filename', async () => {
    const before = await readState();
    for (const id of ['absent', operation.cardId, operation.path, filename]) {
      expect(await repository.finishDelivery(id, delivery)).toEqual({ status: 'missing' });
    }
    expect(await readState()).toEqual(before);
  });

  it.each(inactiveStates)('ignores $status operations even when the draft matches', async state => {
    await putRow('outbox', { ...operation, state });
    const before = await readState();
    expect(await repository.finishDelivery(operation.id, delivery)).toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(await readState()).toEqual(before);
  });

  it('ignores a stale delivery ID without clearing the draft or changing counters', async () => {
    const before = await readState();
    expect(await repository.finishDelivery(operation.id, { ...delivery, deliveryId: 'old-delivery' }))
      .toEqual({ status: 'ignored', reason: 'stale-delivery' });
    expect(await readState()).toEqual(before);
  });

  it('ignores a duplicate success after confirmation without overwriting a later downloaded source', async () => {
    expect(await repository.finishDelivery(operation.id, delivery)).toEqual(changed(completed(), 'confirmed'));
    await putRow('markdownDocuments', { filename, source: 'Later downloaded source' });
    const before = await readState();
    expect(await repository.finishDelivery(operation.id, { ...delivery, now: delivery.now + 100 }))
      .toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(await readState()).toEqual(before);
  });
});

const failedCases: { label: string; outcome: CardSaveDelivery['outcome']; state: OutboxState }[] = [
  { label: 'retryable network failure', outcome: { status: 'failed', reason: 'network', outcome: 'not-written' },
    state: { status: 'failed', reason: 'network', nextAttemptAt: 24_000 } },
  { label: 'blocked auth failure', outcome: { status: 'failed', reason: 'auth', outcome: 'not-written' },
    state: { status: 'failed', reason: 'auth', nextAttemptAt: null } },
  { label: 'conflict', outcome: { status: 'conflict' }, state: { status: 'conflict' } },
  { label: 'unknown network outcome', outcome: { status: 'failed', reason: 'network', outcome: 'unknown' },
    state: { status: 'uncertain', deliveryId: 'delivery-A', reason: 'network' } },
  { label: 'unknown auth outcome', outcome: { status: 'failed', reason: 'auth', outcome: 'unknown' },
    state: { status: 'uncertain', deliveryId: 'delivery-A', reason: 'auth' } }
];

describe('CardSaveRepository: retain local work for unsuccessful deliveries', () => {
  it.each(failedCases)('records $label through the outbox lifecycle without acknowledging a draft', async ({ outcome, state }) => {
    const before = await readState();
    const expected = { ...operation, attempts: 3, state };
    expect(await repository.finishDelivery(operation.id, { ...delivery, outcome })).toEqual(changed(expected, 'retained'));
    expect(await readState()).toEqual(expectedState(before, expected, 'retained'));
  });

  it.each(['success', 'failure'] as const)('captures the entire %s event before awaiting storage', async kind => {
    const before = await readState();
    const event = structuredClone(delivery);
    if (kind === 'failure') event.outcome = structuredClone(failedCases[0].outcome);
    const finishing = repository.finishDelivery(operation.id, event);
    event.deliveryId = 'mutated-delivery';
    event.now++;
    event.policy.baseDelayMs = 1;
    event.policy.maxDelayMs = 1;
    if (event.outcome.status === 'written') event.outcome.revision = 'mutated-revision';
    else event.outcome = { status: 'conflict' };
    const expected: OutboxOperation = kind === 'success' ? completed() : { ...operation, attempts: 3, state: failedCases[0].state };
    const draft = kind === 'success' ? 'confirmed' : 'retained';
    expect(await finishing).toEqual(changed(expected, draft));
    expect(await readState()).toEqual(expectedState(before, expected, draft));
  });

  it('returns detached operation data without mutating the submitted event', async () => {
    const before = await readState();
    const event = structuredClone(delivery);
    const result = await repository.finishDelivery(operation.id, event);
    expect(result).toEqual(changed(completed(), 'confirmed'));
    if (result.status !== 'changed') throw new Error('Expected changed delivery');
    result.operation.source = 'mutated-result';
    result.operation.state = { status: 'conflict' };
    if (result.operation.base.kind === 'present') result.operation.base.revision = 'mutated-base';
    expect(event).toEqual(delivery);
    expect(await readState()).toEqual(expectedState(before, completed(), 'confirmed'));
  });
});

describe('CardSaveRepository: commit and rollback of delivery acknowledgement', () => {
  it.each(sites)('rolls back an abort after $label success and permits an explicit retry', async site => {
    const before = await readState();
    const spy = intercept(site, (store, enqueue) => {
      const request = enqueue();
      // Let all success handlers enqueue their work, then abort before the next
      // native IndexedDB task. No fake clock or assumption about listener order.
      request.addEventListener('success', () => queueMicrotask(() => store.transaction.abort()));
      return request;
    });
    await expect(repository.finishDelivery(operation.id, delivery)).rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(await repository.finishDelivery(operation.id, delivery)).toEqual(changed(completed(), 'confirmed'));
    expect(await readState()).toEqual(expectedState(before, completed(), 'confirmed'));
  });

  it.each(['missing', 'ignored'] as const)('rejects an aborted %s transaction instead of returning a business result', async kind => {
    const before = await readState();
    const spy = intercept(sites[0], (store, enqueue) => {
      const request = enqueue();
      request.addEventListener('success', () => queueMicrotask(() => store.transaction.abort()));
      return request;
    });
    await expect(repository.finishDelivery(kind === 'missing' ? 'absent' : history[0].id, delivery))
      .rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it.each(sites)('retains the original synchronous $label error without partial writes or retries', async site => {
    const before = await readState();
    const error = new DOMException('Acknowledgement storage failed', 'QuotaExceededError');
    let failures = 0;
    const spy = intercept(site, () => { failures++; throw error; });
    await expect(repository.finishDelivery(operation.id, delivery)).rejects.toBe(error);
    expect(failures).toBe(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(await repository.finishDelivery(operation.id, delivery)).toEqual(changed(completed(), 'confirmed'));
    expect(await readState()).toEqual(expectedState(before, completed(), 'confirmed'));
  });

  it.each(['outbox', 'markdownDocuments'])('propagates native asynchronous %s failure and rolls back completion, cache and draft removal', async storeName => {
    const before = await readState();
    const captured: { error: DOMException | null } = { error: null };
    let failures = 0;
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name !== storeName) return put.apply(this, args);
      failures++;
      const request = this.add(...args); // Both records already exist: native ConstraintError.
      request.addEventListener('error', () => { captured.error = request.error; });
      return request;
    });
    const result = await repository.finishDelivery(operation.id, delivery).then(
      value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error })
    );
    expect(result).toMatchObject({ status: 'rejected', error: { name: 'ConstraintError' } });
    expect(captured.error).not.toBeNull();
    expect(result).toEqual({ status: 'rejected', error: captured.error });
    expect(failures).toBe(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it('propagates transaction creation failure without retry', async () => {
    const before = await readState();
    const error = new DOMException('Connection unavailable', 'InvalidStateError');
    const spy = vi.spyOn(database, 'transaction').mockImplementation(() => { throw error; });
    await expect(repository.finishDelivery(operation.id, delivery)).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it('rejects a closed connection without opening another one', async () => {
    const before = await readState();
    database.close();
    const open = vi.spyOn(indexedDB, 'open');
    await expect(repository.finishDelivery(operation.id, delivery)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it.each(stores)('rejects a missing %s store without repair or false confirmation', async store => {
    const name = `Missing-${store}`;
    const db = await openFixture(name, store);
    const before = await readState(name);
    await expect(new IndexedDbCardSaveRepository(db).finishDelivery(operation.id, delivery))
      .rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await readState(name)).toEqual(before);
    expect([...db.objectStoreNames]).not.toContain(store);
  });
});

describe('CardSaveRepository: delivery concurrency and connection ownership', () => {
  it('uses one three-store transaction on its borrowed connection without touching cards', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const transactions = vi.spyOn(database, 'transaction');
    expect(await repository.finishDelivery(operation.id, delivery)).toEqual(changed(completed(), 'confirmed'));
    expect(transactions.mock.results.map(result => {
      const tx: IDBTransaction = result.value;
      return { stores: [...tx.objectStoreNames], mode: tx.mode };
    })).toEqual([{ stores: [...stores], mode: 'readwrite' }]);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('accepts one of two concurrent results for the same delivery without replacing its confirmed revision', async () => {
    const before = await readState();
    const other = new IndexedDbCardSaveRepository(await openFixture());
    const second: CardSaveDelivery = { ...delivery, now: delivery.now + 100,
      outcome: { status: 'written', revision: 'second-result' } };
    const results = await Promise.all([
      repository.finishDelivery(operation.id, delivery), other.finishDelivery(operation.id, second)
    ]);
    expect(results.map(result => result?.status).sort()).toEqual(['changed', 'ignored']);
    const winner = results.findIndex(result => result.status === 'changed');
    const expected = winner === 0 ? completed() : completed(operation, 'second-result', second.now);
    expect(results[winner]).toEqual(changed(expected, 'confirmed'));
    expect(results[1 - winner]).toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(await readState()).toEqual(expectedState(before, expected, 'confirmed'));
  });

  it.each(['finish-first', 'save-first'] as const)('preserves a concurrent newer Save in %s order', async order => {
    const before = await readState();
    const other = new IndexedDbCardSaveRepository(await openFixture());
    const next: CardSaveDraft = {
      id: 'newer-save', path: operation.path, base: operation.base,
      createOnly: false, createdAt: operation.createdAt + 1,
      document: { version: 1, source: source.replace('# Карточка 🗂', '# Newer Save'),
        card: { ...v1Card, title: 'Newer Save' } }
    };
    let finishing: Promise<CardSaveDeliveryResult>;
    let saving: Promise<OutboxOperation>;
    if (order === 'finish-first') {
      finishing = repository.finishDelivery(operation.id, delivery);
      saving = other.save(next);
    } else {
      saving = other.save(next);
      finishing = repository.finishDelivery(operation.id, delivery);
    }
    const [result, saved] = await Promise.all([finishing, saving]);
    const draft = order === 'finish-first' ? 'confirmed' : 'superseded';
    expect(result).toEqual(changed(completed(), draft));
    const nextOperation: OutboxOperation = {
      id: next.id, cardId: next.document.card.meta.id, path: next.path, source: next.document.source,
      base: next.base, createOnly: next.createOnly, createdAt: next.createdAt, attempts: 0,
      state: { status: 'pending', nextAttemptAt: next.createdAt }
    };
    expect(saved).toEqual(nextOperation);
    const after = expectedState(before, completed(), draft);
    after.records.cards = upsert(after.records.cards as ReturnType<typeof storedCard>[],
      storedCard(next.document.card, next.path.slice(0, -3)), row => row.meta.id);
    after.records.localMarkdownSnapshots = upsert(after.records.localMarkdownSnapshots as SavedMarkdownDraft[],
      { filename, source: next.document.source, saveMode: 'update', saveId: next.id }, row => row.filename);
    after.records.outbox = upsert(after.records.outbox as OutboxOperation[], nextOperation, row => row.id);
    expect(await readState()).toEqual(after);
  });
});
