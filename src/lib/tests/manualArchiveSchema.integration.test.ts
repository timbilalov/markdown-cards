import { expect, it, vi } from 'vitest';
import { DBService } from '../services/dbService';

const rows = {
  cards: { meta: { id: 'card' }, extra: 'opaque' },
  files: { path: 'opaque.md' },
  syncQueue: { id: 'old', status: 'processing' },
  markdownDocuments: { filename: 'raw', source: '\uFEFFlegacy\r\n' },
  localMarkdownSnapshots: {
    filename: 'draft',
    source: 'pending exact',
    saveId: 'saved',
    saveMode: 'update'
  },
  outbox: { id: 'saved', path: 'draft.md', state: { status: 'uncertain' }, source: 'pending exact' }
};

async function seed() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('MarkdownCardsDB', 5);
    r.onupgradeneeded = () => {
      for (const [name, row] of Object.entries(rows)) {
        const keyPath =
          name === 'cards'
            ? 'meta.id'
            : name === 'files'
              ? 'path'
              : ['markdownDocuments', 'localMarkdownSnapshots'].includes(name)
                ? 'filename'
                : 'id';
        r.result.createObjectStore(name, { keyPath }).put(row);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
}

async function state() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('MarkdownCardsDB');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise<{ version: number; records: Record<string, unknown[]> }>(
      (resolve, reject) => {
        const names = [...db.objectStoreNames];
        const tx = db.transaction(names);
        const reads = names.map(name => tx.objectStore(name).getAll());
        tx.oncomplete = () =>
          resolve({
            version: db.version,
            records: Object.fromEntries(names.map((name, i) => [name, reads[i].result]))
          });
        tx.onabort = () => reject(tx.error);
      }
    );
  } finally {
    db.close();
  }
}

it('adds a manual archive to populated v5 without changing any prior raw record or delivery state', async () => {
  await seed();
  const before = await state();
  await new DBService().init();
  const after = await state();
  expect(after).toEqual({ version: 6, records: { ...before.records, manualSyncArchives: [] } });
});

it('rolls back the entire additive v5 upgrade if archive creation fails', async () => {
  await seed();
  const before = await state();
  const create = IDBDatabase.prototype.createObjectStore;
  vi.spyOn(IDBDatabase.prototype, 'createObjectStore').mockImplementation(function (
    this: IDBDatabase,
    name,
    options
  ) {
    if (name === 'manualSyncArchives') throw new DOMException('quota', 'QuotaExceededError');
    return create.call(this, name, options);
  });
  await expect(new DBService().init()).rejects.toThrow();
  expect(await state()).toEqual(before);
});
