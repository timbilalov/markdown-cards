import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbCardSaveRepository } from '../adapters/indexedDb/cardSaveRepository';
import type { CardSaveDraft, CardSaveRepository, SavedMarkdownDraft } from '../ports/cardSaveRepository';
import type { OutboxOperation, OutboxState } from '../domain/outbox';
import type { RemoteBase } from '../domain/types';
import { legacyRecords } from './helpers/legacyDatabase';
import { makeCard, storedCard } from './helpers/fixtures';
import { v1, v1Card, futureV1Shape } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

const databaseName = 'CardSaveRepositoryTestDB';
const filename = 'Архив.md.🗂';
const source = (v1 + '\n\n').replaceAll('\n', '\r\n');
const input: CardSaveDraft = {
  id: 'new-save', path: `${filename}.md`, createOnly: false,
  base: { kind: 'present', revision: ' opaque/base ' }, createdAt: 10_000,
  document: { version: 1, source, card: v1Card }
};
const oldSource = source.replace('# Карточка 🗂', '# Earlier Save');
const states: OutboxState[] = [
  { status: 'pending', nextAttemptAt: 100 },
  { status: 'processing', deliveryId: 'sending-1', startedAt: 200 },
  { status: 'failed', reason: 'network', nextAttemptAt: 9000 },
  { status: 'uncertain', deliveryId: 'interrupted-3', reason: 'interrupted' },
  { status: 'conflict' },
  { status: 'completed', revision: 'confirmed/5', completedAt: 500 },
  { status: 'failed', reason: 'auth', nextAttemptAt: null }
];
const history: OutboxOperation[] = states.map((state, i) => ({
  id: `history-${i}`, cardId: v1Card.meta.id, path: input.path, source: oldSource,
  createOnly: false, base: { kind: 'present', revision: 'older/base' },
  createdAt: 100 - i, attempts: i, state
}));
const oldDraft = { filename, source: oldSource, saveMode: 'update', saveId: history[0].id };
const legacyDraft = { filename: 'other.md.keep', source: v1, saveMode: 'create' };
const affectedStores = ['cards', 'localMarkdownSnapshots', 'outbox'] as const;
type AffectedStore = typeof affectedStores[number];
let database: IDBDatabase;
let repository: CardSaveRepository;

// Physical v5, seeded without DBService or the target repository. Include all
// legacy data and outbox states so a raw six-store oracle catches collateral edits.
function openFixture(name = databaseName, omitted?: AffectedStore): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (omitted !== 'cards') {
        const cards = db.createObjectStore('cards', { keyPath: 'meta.id' });
        cards.createIndex('title', 'meta.title');
        cards.createIndex('modified', 'meta.modified');
        for (const card of legacyRecords.cards) cards.put(card);
        cards.put(storedCard(makeCard({ meta: { ...v1Card.meta, id: 'unrelated-card' } })));
      }
      const files = db.createObjectStore('files', { keyPath: 'path' });
      for (const file of legacyRecords.files) files.put(file);
      const queue = db.createObjectStore('syncQueue', { keyPath: 'id' });
      for (const operation of legacyRecords.syncQueue) queue.put(operation);
      const documents = db.createObjectStore('markdownDocuments', { keyPath: 'filename' });
      documents.put({ filename, source: futureV1Shape });
      documents.put({ filename: 'legacy-document', source: legacy });
      if (omitted !== 'localMarkdownSnapshots') {
        const drafts = db.createObjectStore('localMarkdownSnapshots', { keyPath: 'filename' });
        drafts.put(oldDraft);
        drafts.put(legacyDraft);
      }
      if (omitted !== 'outbox') {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        for (const operation of history) outbox.add(operation);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readState(name = databaseName) {
  const db = await openFixture(name);
  try {
    return await new Promise<{ version: number; records: Record<string, unknown[]> }>((resolve, reject) => {
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

// Explicit expected records, independent of the domain factory and adapter.
function expectedOperation(draft: CardSaveDraft): OutboxOperation {
  return {
    id: draft.id, cardId: draft.document.card.meta.id, path: draft.path,
    source: draft.document.source, createOnly: draft.createOnly, base: structuredClone(draft.base),
    createdAt: draft.createdAt, attempts: 0,
    state: { status: 'pending', nextAttemptAt: draft.createdAt }
  };
}

function expectedDraft(draft: CardSaveDraft): SavedMarkdownDraft {
  return { filename: draft.path.slice(0, -3), source: draft.document.source,
    saveMode: draft.createOnly ? 'create' : 'update', saveId: draft.id };
}

function upsert<T>(rows: T[], value: T, key: (row: T) => string): T[] {
  return [...rows.filter(row => key(row) !== key(value)), value]
    .sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function expectedState(before: Awaited<ReturnType<typeof readState>>, ...saves: CardSaveDraft[]) {
  const records = { ...before.records };
  for (const save of saves) {
    records.cards = upsert(records.cards as ReturnType<typeof storedCard>[],
      storedCard(save.document.card, save.path.slice(0, -3)), row => row.meta.id);
    records.localMarkdownSnapshots = upsert(records.localMarkdownSnapshots as SavedMarkdownDraft[],
      expectedDraft(save), row => row.filename);
    records.outbox = upsert(records.outbox as OutboxOperation[], expectedOperation(save), row => row.id);
  }
  return { ...before, records };
}

function interceptWrite(storeName: AffectedStore, effect: (store: IDBObjectStore, enqueue: () => IDBRequest) => IDBRequest) {
  const method = storeName === 'outbox' ? 'add' : 'put';
  const original = IDBObjectStore.prototype[method];
  return vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args) {
    const enqueue = () => original.apply(this, args);
    return this.name === storeName ? effect(this, enqueue) : enqueue();
  });
}

beforeEach(async () => {
  database = await openFixture();
  repository = new IndexedDbCardSaveRepository(database);
});

describe('CardSaveRepository: commit one immutable local Save', () => {
  it.each([true, false])('saves exact document, projection and pending outbox with createOnly=%s', async createOnly => {
    const before = await readState();
    const draft = { ...input, createOnly, base: createOnly ? { kind: 'missing' as const } : input.base };
    expect(await repository.save(draft)).toEqual(expectedOperation(draft));
    expect(await readState()).toEqual(expectedState(before, draft));
  });

  it.each<RemoteBase>([{ kind: 'unknown' }, { kind: 'present', revision: null }])('retains $kind base without inferring a revision or remote absence', async base => {
    const before = await readState();
    const draft = { ...input, base };
    expect(await repository.save(draft)).toEqual(expectedOperation(draft));
    expect(await readState()).toEqual(expectedState(before, draft));
  });

  it('creates a previously absent Card and filename without replacing existing local work', async () => {
    const before = await readState();
    const draft: CardSaveDraft = { ...input, path: 'New.md.📝.md', createOnly: true,
      base: { kind: 'missing' }, document: {
        ...input.document, source: source.replace('\r\ntest-card\r\n', '\r\nnew-card\r\n'),
        card: { ...v1Card, meta: { ...v1Card.meta, id: 'new-card' } }
      } };
    expect(await repository.save(draft)).toEqual(expectedOperation(draft));
    expect(await readState()).toEqual(expectedState(before, draft));
  });

  it('captures nested document, base and routing fields before its first await', async () => {
    const before = await readState();
    const draft = structuredClone(input);
    const submitted = structuredClone(draft);
    const saving = repository.save(draft);
    draft.id = 'changed-id';
    draft.path = 'changed-path.md';
    draft.createOnly = true;
    draft.createdAt++;
    draft.document.source = 'changed-source';
    draft.document.card.meta.id = 'changed-card';
    draft.document.card.meta.modified++;
    draft.document.card.title = 'Changed title';
    draft.document.card.sections[0].items[0].text = 'Changed nested item';
    draft.document.card.tags?.push('changed-tag');
    if (draft.base.kind === 'present') draft.base.revision = 'changed-base';
    expect(await saving).toEqual(expectedOperation(submitted));
    expect(await readState()).toEqual(expectedState(before, submitted));
  });

  it('returns a detached committed operation without mutating caller input', async () => {
    const before = await readState();
    const draft = structuredClone(input);
    const submitted = structuredClone(draft);
    const saved = await repository.save(draft);
    expect(saved).toEqual(expectedOperation(submitted));
    saved.source = 'changed-return-value';
    saved.state = { status: 'conflict' };
    if (saved.base.kind === 'present') saved.base.revision = 'changed-return-base';
    expect(draft).toEqual(submitted);
    expect(await readState()).toEqual(expectedState(before, submitted));
  });

  it('persists the three records across an owner reconnect', async () => {
    const before = await readState();
    expect(await repository.save(input)).toEqual(expectedOperation(input));
    database.close();
    database = await openFixture();
    expect(await readState()).toEqual(expectedState(before, input));
  });

  it('assigns the newest Save ID even when the source is unchanged, preserving all previous operations', async () => {
    const before = await readState();
    const next = { ...input, id: 'next-save', createdAt: input.createdAt - 1 };
    expect(await repository.save(input)).toEqual(expectedOperation(input));
    expect(await repository.save(next)).toEqual(expectedOperation(next));
    expect(await readState()).toEqual(expectedState(before, input, next));
  });

  it('addresses drafts by path, preserving another filename with the same Card ID', async () => {
    const before = await readState();
    const draft = { ...input, path: `${legacyDraft.filename}.md` };
    expect(await repository.save(draft)).toEqual(expectedOperation(draft));
    expect(await readState()).toEqual(expectedState(before, draft));
  });

  it('rejects repeating an identical Save ID and payload instead of silently succeeding', async () => {
    expect(await repository.save(input)).toEqual(expectedOperation(input));
    const before = await readState();
    await expect(repository.save(input)).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readState()).toEqual(before);
  });

  it.each(['history-0', 'history-5'])('rejects reusing existing ID %s and rolls back the new Card and draft', async id => {
    const before = await readState();
    const draft = { ...input, id, path: 'different-filename.md' };
    await expect(repository.save(draft)).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readState()).toEqual(before);
  });
});

describe('CardSaveRepository: atomic rollback and storage failures', () => {
  it.each(affectedStores)('rejects abort after %s request success, rolls back every store and permits explicit retry', async store => {
    const before = await readState();
    const spy = interceptWrite(store, (objectStore, enqueue) => {
      const request = enqueue();
      request.addEventListener('success', () => objectStore.transaction.abort());
      return request;
    });
    await expect(repository.save(input)).rejects.toMatchObject({ name: 'AbortError' });
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(await repository.save(input)).toEqual(expectedOperation(input));
    expect(await readState()).toEqual(expectedState(before, input));
  });

  it.each(affectedStores)('propagates synchronous %s failure once and rolls back earlier writes', async store => {
    const before = await readState();
    const error = new DOMException('Save quota exceeded', 'QuotaExceededError');
    let failures = 0;
    const spy = interceptWrite(store, () => { failures++; throw error; });
    await expect(repository.save(input)).rejects.toBe(error);
    expect(failures).toBe(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
    expect(await repository.save(input)).toEqual(expectedOperation(input));
    expect(await readState()).toEqual(expectedState(before, input));
  });

  it.each(['cards', 'localMarkdownSnapshots'] as const)('propagates native asynchronous %s failure after rolling back the whole Save', async store => {
    const before = await readState();
    const captured: { error: DOMException | null } = { error: null };
    let failures = 0;
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name !== store) return put.apply(this, args);
      failures++;
      // The addressed Card/draft already exists: native request ConstraintError.
      const request = this.add(...args);
      request.addEventListener('error', () => { captured.error = request.error; });
      return request;
    });
    const outcome = await repository.save(input).then(
      value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error })
    );
    expect(outcome).toMatchObject({ status: 'rejected', error: { name: 'ConstraintError' } });
    expect(captured.error).not.toBeNull();
    expect(outcome).toEqual({ status: 'rejected', error: captured.error });
    expect(failures).toBe(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it('rejects an uncloneable nested input without leaving a partial Save', async () => {
    const before = await readState();
    const draft = structuredClone(input);
    Object.assign(draft.document.card, { uncloneable: () => undefined });
    await expect(repository.save(draft)).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(await readState()).toEqual(before);
  });

  it('propagates a transaction creation failure without automatic retry', async () => {
    const before = await readState();
    const error = new DOMException('Database unavailable', 'InvalidStateError');
    const spy = vi.spyOn(database, 'transaction').mockImplementation(() => { throw error; });
    await expect(repository.save(input)).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it('rejects a closed connection without reopening or losing data', async () => {
    const before = await readState();
    database.close();
    const open = vi.spyOn(indexedDB, 'open');
    await expect(repository.save(input)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    expect(await readState()).toEqual(before);
  });

  it.each(affectedStores)('rejects a missing %s store without repairing the schema or writing other stores', async store => {
    const name = `Missing-${store}`;
    const db = await openFixture(name, store);
    const before = await readState(name);
    await expect(new IndexedDbCardSaveRepository(db).save(input)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await readState(name)).toEqual(before);
    expect([...db.objectStoreNames]).not.toContain(store);
  });
});

describe('CardSaveRepository: transaction ownership and competing connections', () => {
  it('borrows the connection and commits through a single three-store transaction', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(database, 'close');
    const transactions = vi.spyOn(database, 'transaction');
    expect(await repository.save(input)).toEqual(expectedOperation(input));
    expect(transactions.mock.results.map(result => {
      const tx: IDBTransaction = result.value;
      return { stores: [...tx.objectStoreNames], mode: tx.mode };
    })).toEqual([{ stores: [...affectedStores], mode: 'readwrite' }]);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('serializes distinct concurrent Saves without losing either outbox record', async () => {
    const before = await readState();
    const other = new IndexedDbCardSaveRepository(await openFixture());
    const next = { ...input, id: 'next-save', createdAt: input.createdAt - 1,
      document: { ...input.document, source: oldSource,
        card: { ...v1Card, title: 'Earlier Save' } } };
    expect(await Promise.all([repository.save(input), other.save(next)]))
      .toEqual([expectedOperation(input), expectedOperation(next)]);
    expect(await readState()).toEqual(expectedState(before, input, next));
  });

  it('commits one winner for a concurrent duplicate Save ID and leaves no loser draft or Card', async () => {
    const before = await readState();
    const other = new IndexedDbCardSaveRepository(await openFixture());
    const contender = { ...input, path: 'contender.md', document: {
      ...input.document, source: source.replace('\r\ntest-card\r\n', '\r\ncontender-card\r\n'),
      card: { ...v1Card, meta: { ...v1Card.meta, id: 'contender-card' } }
    } };
    const candidates = [input, contender];
    const results = await Promise.allSettled([repository.save(input), other.save(contender)]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    expect(results[winner]).toEqual({ status: 'fulfilled', value: expectedOperation(candidates[winner]) });
    expect(results[1 - winner]).toMatchObject({ status: 'rejected', reason: { name: 'ConstraintError' } });
    expect(await readState()).toEqual(expectedState(before, candidates[winner]));
  });
});
