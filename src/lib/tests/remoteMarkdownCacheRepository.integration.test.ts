import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbRemoteMarkdownCacheRepository } from '../adapters/indexedDb/remoteMarkdownCacheRepository';
import { IndexedDbCardSaveRepository } from '../adapters/indexedDb/cardSaveRepository';
import type { RemoteMarkdownCacheRefresh } from '../ports/remoteMarkdownCacheRepository';
import type { CardSaveDraft, SavedMarkdownDraft } from '../ports/cardSaveRepository';
import type { OutboxOperation, OutboxState } from '../domain/outbox';
import { storedCard } from './helpers/fixtures';
import { v1, v1Card, futureV1Shape } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const databaseName = 'RemoteMarkdownCacheTestDB';
const filename = 'Архив.md.🗂';
const source = (v1 + '\n\n').replaceAll('\n', '\r\n');
const oldSource = v1.replace('# Карточка 🗂', '# Earlier card');
const oldCard = storedCard({ ...v1Card, title: 'Earlier card' });
const input: RemoteMarkdownCacheRefresh = {
  filename, source, card: v1Card, expected: { source: oldSource, card: oldCard }
};
const scope = ['cards', 'localMarkdownSnapshots', 'markdownDocuments', 'outbox', 'syncQueue'] as const;
type Store = typeof scope[number];
type State = { version: number; records: Record<string, unknown[]> };
const updated = { status: 'updated' };
const localWork = { status: 'retained', reason: 'local-work' };
const changed = { status: 'retained', reason: 'changed' };
const activeStates: OutboxState[] = [
  { status: 'pending', nextAttemptAt: 100 },
  { status: 'processing', deliveryId: 'delivery-A', startedAt: 200 },
  { status: 'failed', reason: 'network', nextAttemptAt: 9000 },
  { status: 'failed', reason: 'auth', nextAttemptAt: null },
  { status: 'uncertain', deliveryId: 'delivery-A', reason: 'interrupted' },
  { status: 'conflict' }
];
const operation: OutboxOperation = {
  id: 'local-save', cardId: v1Card.meta.id, path: `${filename}.md`,
  source: v1.replace('# Карточка 🗂', '# Local Save'), createOnly: false,
  base: { kind: 'present', revision: ' base/revision ' }, createdAt: 1000, attempts: 0,
  state: { status: 'pending', nextAttemptAt: 1000 }
};
const draft: SavedMarkdownDraft = {
  filename, source: operation.source, saveMode: 'update', saveId: operation.id
};
const localCard = { ...v1Card, title: 'Local Save' };
let database: IDBDatabase;
let repository: IndexedDbRemoteMarkdownCacheRepository;

// Independent physical v5 fixture; no production read/write helper seeds the
// target. Raw six-store comparisons detect collateral edits and lost drafts.
function openFixture(name = databaseName, omitted?: Store): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (omitted !== 'cards') {
        const cards = db.createObjectStore('cards', { keyPath: 'meta.id' });
        cards.createIndex('title', 'meta.title');
        cards.createIndex('modified', 'meta.modified');
        cards.put(oldCard);
        cards.put(storedCard({ ...v1Card, meta: { ...v1Card.meta, id: 'unrelated-card' } }));
      }
      const files = db.createObjectStore('files', { keyPath: 'path' });
      files.put({ path: 'unrelated.md', name: 'unrelated.md', modified: 'not-a-clock' });
      for (const store of ['syncQueue', 'outbox'] as const) {
        if (omitted !== store) db.createObjectStore(store, { keyPath: 'id' });
      }
      if (omitted !== 'localMarkdownSnapshots') {
        db.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' });
      }
      if (omitted !== 'markdownDocuments') {
        const documents = db.createObjectStore('markdownDocuments', { keyPath: 'filename' });
        documents.put({ filename, source: oldSource });
        documents.put({ filename: 'unrelated-document', source: legacy });
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

function editRow(store: Store, edit: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite');
    edit(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

function putRow(store: Store, row: unknown) {
  return editRow(store, objectStore => { objectStore.put(row); });
}

function replaceRow(state: State, store: Store, row: unknown, key: string, value: string) {
  // Test oracle uses known physical keys, not any production policy or codec.
  const records = state.records[store] as Record<string, unknown>[];
  state.records[store] = [...records.filter(record => {
    const current = key === 'meta.id' ? (record.meta as { id: string }).id : record[key];
    return current !== value;
  }), row].sort((left, right) => {
    const keyOf = (record: unknown) => key === 'meta.id'
      ? (record as { meta: { id: string } }).meta.id : (record as Record<string, string>)[key];
    return keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0;
  });
}

function refreshed(before: State, request = input): State {
  const state = structuredClone(before);
  replaceRow(state, 'markdownDocuments', { filename: request.filename, source: request.source }, 'filename', request.filename);
  if (request.card) replaceRow(state, 'cards', storedCard(request.card, request.filename), 'meta.id', request.card.meta.id);
  return state;
}

function interceptPut(store: Store, effect: (store: IDBObjectStore, enqueue: () => IDBRequest) => IDBRequest) {
  const put = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    const enqueue = () => put.apply(this, args);
    return this.name === store ? effect(this, enqueue) : enqueue();
  });
}

beforeEach(async () => {
  database = await openFixture();
  repository = new IndexedDbRemoteMarkdownCacheRepository(database);
});

describe('Remote Markdown cache: exact atomic replacement', () => {
  it('commits exact CRLF source and Card with index alias, preserving timestamps and unrelated data', async () => {
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before));
  });

  it.each([['legacy', legacy], ['future', futureV1Shape]])('caches refused %s source without replacing Card', async (_label, refused) => {
    const before = await readState();
    const request = { ...input, source: refused, card: null,
      expected: { source: oldSource, card: null } };
    expect(await repository.refresh(request)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before, request));
  });

  it('creates absent source and projection only when both expected records are absent', async () => {
    await editRow('cards', store => { store.delete(v1Card.meta.id); });
    await editRow('markdownDocuments', store => { store.delete(filename); });
    const before = await readState();
    const request = { ...input, expected: { source: null, card: null } };
    expect(await repository.refresh(request)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before, request));
  });

  it('compares projection fields regardless of object property insertion order', async () => {
    const before = await readState();
    const reordered = { ...Object.fromEntries(Object.entries(oldCard).reverse()),
      meta: { modified: oldCard.meta.modified, title: oldCard.meta.title,
        created: oldCard.meta.created, id: oldCard.meta.id } } as typeof oldCard;
    const request = { ...input, expected: { source: oldSource, card: reordered } };
    expect(await repository.refresh(request)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before));
  });

  it('captures routing, source, nested Card and expected records before yielding', async () => {
    const before = await readState();
    const request = structuredClone(input);
    const refreshing = repository.refresh(request);
    request.filename = 'mutated-filename';
    request.source = 'mutated-source';
    request.card!.meta.id = 'mutated-id';
    request.card!.sections[0].items[0].text = 'mutated-item';
    request.expected.source = 'mutated-expected';
    request.expected.card!.title = 'mutated-expected-title';
    expect(await refreshing).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before));
  });
});

describe('Remote Markdown cache: stale download guards', () => {
  it.each([
    ['source changed', 'markdownDocuments', { filename, source: oldSource + '\n' }],
    ['Card changed at the same timestamp', 'cards', storedCard({ ...oldCard, description: 'Local edit' })],
    ['Card index alias changed', 'cards', { ...oldCard, meta: { ...oldCard.meta, title: 'Different alias' } }]
  ] as const)('retains all records when %s since capture', async (_label, store, row) => {
    await putRow(store, row);
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(changed);
    expect(await readState()).toEqual(before);
  });

  it.each(['cards', 'markdownDocuments'] as const)('retains records when %s was removed since capture', async store => {
    await editRow(store, objectStore => { objectStore.delete(store === 'cards' ? v1Card.meta.id : filename); });
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(changed);
    expect(await readState()).toEqual(before);
  });

  it.each(['card', 'source'] as const)('retains records when %s appeared after an absent capture', async key => {
    const before = await readState();
    expect(await repository.refresh({ ...input, expected: { ...input.expected, [key]: null } })).toEqual(changed);
    expect(await readState()).toEqual(before);
  });
});

describe('Remote Markdown cache: preserve current and historical local work', () => {
  it.each([
    ['historical snapshot', { filename, source: v1, saveMode: 'update' }],
    ['snapshot with Save ID', draft],
    ['same Card under another filename', { ...draft, filename: 'another-filename' }],
    ['unidentifiable legacy snapshot', { ...draft, filename: 'unknown-owner', source: legacy }],
    ['unidentifiable future snapshot', { ...draft, filename: 'unknown-owner', source: futureV1Shape }]
  ])('retains both cache records for %s', async (_label, row) => {
    await putRow('localMarkdownSnapshots', row);
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });

  it('protects source-only replacement by the exact draft filename', async () => {
    await putRow('localMarkdownSnapshots', { ...draft, source: 'unparseable local text' });
    const before = await readState();
    expect(await repository.refresh({ ...input, card: null, source: legacy })).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });

  it.each(activeStates)('protects Card ID despite another path for outbox state $status / $reason', async state => {
    await putRow('outbox', { ...operation, path: 'another-path.md', state });
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });

  it('protects source-only replacement by outbox path even with a different Card ID', async () => {
    await putRow('outbox', { ...operation, cardId: 'another-card' });
    const before = await readState();
    expect(await repository.refresh({ ...input, card: null, source: futureV1Shape })).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });

  it.each(['pending', 'processing', 'failed'])('protects a legacy %s operation by card.meta.id', async status => {
    await putRow('syncQueue', { id: 'legacy', type: 'update', card: oldCard, timestamp: 100, attempts: 3, status });
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });

  it('protects a legacy delete with only top-level cardId', async () => {
    await putRow('syncQueue', { id: 'legacy-delete', type: 'delete', cardId: v1Card.meta.id,
      timestamp: 100, attempts: 0, status: 'pending' });
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });

  it('protects source-only replacement by legacy path without a Card', async () => {
    await putRow('syncQueue', { id: 'legacy-path', path: `${filename}.md`, type: 'update',
      timestamp: 100, attempts: 0, status: 'pending' });
    const before = await readState();
    expect(await repository.refresh({ ...input, card: null, source: legacy })).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });

  it('retains completed history without treating it alone as pending work', async () => {
    await putRow('outbox', { ...operation, state: { status: 'completed', revision: 'rev', completedAt: 123 } });
    await putRow('syncQueue', { id: 'legacy-complete', path: `${filename}.md`, card: oldCard,
      type: 'update', timestamp: 100, attempts: 1, status: 'completed' });
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before));
  });

  it('preserves unrelated identifiable drafts and queue rows without blocking refresh', async () => {
    await putRow('localMarkdownSnapshots', { ...draft, filename: 'unrelated',
      source: v1.replace('\ntest-card\n', '\nunrelated-card\n') });
    await putRow('outbox', { ...operation, cardId: 'unrelated-card', path: 'unrelated.md' });
    await putRow('syncQueue', { id: 'unrelated-delete', type: 'delete', cardId: 'unrelated-card',
      timestamp: 100, attempts: 0, status: 'pending' });
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before));
  });

  it('does not infer Card ownership for source-only caching of another filename', async () => {
    await putRow('localMarkdownSnapshots', { ...draft, filename: 'unknown-owner', source: legacy });
    await putRow('outbox', { ...operation, path: 'another-path.md' });
    const before = await readState();
    const request = { ...input, card: null, source: futureV1Shape };
    expect(await repository.refresh(request)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before, request));
  });

  it('reports local-work before changed when both protections apply', async () => {
    await putRow('localMarkdownSnapshots', draft);
    await putRow('markdownDocuments', { filename, source: 'newer cache' });
    const before = await readState();
    expect(await repository.refresh(input)).toEqual(localWork);
    expect(await readState()).toEqual(before);
  });
});

describe('Remote Markdown cache: transaction lifetime and rollback', () => {
  it('uses one five-store readwrite transaction and resolves after commit on the borrowed connection', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const transaction = database.transaction.bind(database);
    let committed = false;
    const transactions = vi.spyOn(database, 'transaction').mockImplementation((...args) => {
      const tx = transaction(...args);
      tx.addEventListener('complete', () => { committed = true; });
      return tx;
    });
    expect(await repository.refresh(input)).toEqual(updated);
    expect(committed).toBe(true);
    expect(transactions.mock.results.map(result => {
      const tx: IDBTransaction = result.value;
      return { stores: [...tx.objectStoreNames], mode: tx.mode };
    })).toEqual([{ stores: [...scope], mode: 'readwrite' }]);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['cards', 'markdownDocuments'] as const)('rolls back both cache records after abort following %s success', async store => {
    const before = await readState();
    let aborted = false;
    const spy = interceptPut(store, (objectStore, enqueue) => {
      objectStore.transaction.addEventListener('abort', () => { aborted = true; });
      const request = enqueue();
      request.addEventListener('success', () => objectStore.transaction.abort());
      return request;
    });
    await expect(repository.refresh(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(await repository.refresh(input)).toEqual(updated);
    expect(await readState()).toEqual(refreshed(before));
  });

  it.each(['cards', 'markdownDocuments'] as const)('preserves the original synchronous %s error without retry or partial writes', async store => {
    const before = await readState();
    const error = new DOMException('Cache quota exceeded', 'QuotaExceededError');
    let failures = 0;
    const spy = interceptPut(store, () => { failures++; throw error; });
    await expect(repository.refresh(input)).rejects.toBe(error);
    expect(failures).toBe(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(await repository.refresh(input)).toEqual(updated);
  });

  it('propagates the original native request error after rollback', async () => {
    const before = await readState();
    const captured: { error: DOMException | null } = { error: null };
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name !== 'cards') return put.apply(this, args);
      const request = this.add(...args);
      request.addEventListener('error', () => { captured.error = request.error; });
      return request;
    });
    const result = await repository.refresh(input).then(value => ({ value }), error => ({ error }));
    expect(result).toMatchObject({ error: { name: 'ConstraintError' } });
    expect(captured.error).not.toBeNull();
    expect(result).toEqual({ error: captured.error });
    spy.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it('rejects a closed connection without reopening', async () => {
    const before = await readState();
    database.close();
    const open = vi.spyOn(indexedDB, 'open');
    await expect(repository.refresh(input)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it('rejects a missing guard store without repairing the schema or replacing cache records', async () => {
    const name = 'Missing-localMarkdownSnapshots';
    const db = await openFixture(name, 'localMarkdownSnapshots');
    const before = await readState(name);
    await expect(new IndexedDbRemoteMarkdownCacheRepository(db).refresh(input)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await readState(name)).toEqual(before);
  });
});

describe('Remote Markdown cache: competing Save and delivery connections', () => {
  it.each([true, false])('keeps a concurrent local Save regardless of transaction order (refresh first: %s)', async refreshFirst => {
    const before = await readState();
    const other = new IndexedDbCardSaveRepository(await openFixture());
    const save: CardSaveDraft = { id: operation.id, path: operation.path, createOnly: false,
      base: operation.base, createdAt: operation.createdAt,
      document: { version: 1, source: operation.source, card: localCard } };
    // Invocation order determines overlapping readwrite transaction ordering.
    const tasks = refreshFirst
      ? [repository.refresh(input), other.save(save)]
      : [other.save(save), repository.refresh(input)];
    const results = await Promise.all(tasks);
    expect(results[refreshFirst ? 0 : 1]).toEqual(refreshFirst ? updated : localWork);
    expect(results[refreshFirst ? 1 : 0]).toEqual(operation);
    const expected = refreshFirst ? refreshed(before) : structuredClone(before);
    replaceRow(expected, 'cards', storedCard(localCard, filename), 'meta.id', localCard.meta.id);
    replaceRow(expected, 'localMarkdownSnapshots', draft, 'filename', filename);
    replaceRow(expected, 'outbox', operation, 'id', operation.id);
    expect(await readState()).toEqual(expected);
  });

  it.each([true, false])('retains an acknowledged Save even after its draft is removed (refresh first: %s)', async refreshFirst => {
    const sending = { ...operation, state: { status: 'processing' as const, deliveryId: 'delivery-A', startedAt: 2000 } };
    await putRow('outbox', sending);
    await putRow('localMarkdownSnapshots', draft);
    await putRow('cards', storedCard(localCard));
    const before = await readState();
    const other = new IndexedDbCardSaveRepository(await openFixture());
    const delivery = { deliveryId: 'delivery-A', now: 3000,
      outcome: { status: 'written' as const, revision: 'new-revision' },
      policy: { baseDelayMs: 1000, maxDelayMs: 5000 } };
    const request = { ...input, expected: { ...input.expected, card: storedCard(localCard) } };
    const tasks = refreshFirst
      ? [repository.refresh(request), other.finishDelivery(operation.id, delivery)]
      : [other.finishDelivery(operation.id, delivery), repository.refresh(request)];
    const results = await Promise.all(tasks);
    expect(results[refreshFirst ? 0 : 1]).toEqual(refreshFirst ? localWork : changed);
    const completed = { ...operation,
      state: { status: 'completed', revision: 'new-revision', completedAt: 3000 } };
    expect(results[refreshFirst ? 1 : 0]).toEqual({ status: 'changed', operation: completed, draft: 'confirmed' });
    const expected = structuredClone(before);
    replaceRow(expected, 'markdownDocuments', { filename, source: operation.source }, 'filename', filename);
    replaceRow(expected, 'outbox', completed, 'id', operation.id);
    expected.records.localMarkdownSnapshots = [];
    expect(await readState()).toEqual(expected);
  });
});
