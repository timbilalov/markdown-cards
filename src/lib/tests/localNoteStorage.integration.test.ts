import { readStorageInventory } from '../application/storageInventory';
import { expect, it, vi } from 'vitest';
import { LocalNoteStorage } from '../adapters/localNoteStorage';
import { createContextDatabase } from '../services/localStorageContexts';
import { v1, v1Card } from './helpers/markdownReadFixtures';

const database = () => createContextDatabase(`ctx-v1-${'f'.repeat(64)}`);
it('lists and reads exact empty/unsupported/BOM sources without reconstructing Cards', async () => {
  const db = database();
  await db.saveMarkdownDocument('raw', '\uFEFFlegacy\r\n');
  await db.saveMarkdownDocument('empty', '');
  const port = new LocalNoteStorage(db);
  expect(await port.list()).toEqual({
    status: 'success',
    entries: [
      { path: 'empty.md', revision: null },
      { path: 'raw.md', revision: null }
    ]
  });
  expect(await port.read('raw.md')).toEqual({
    status: 'found',
    document: { path: 'raw.md', source: '\uFEFFlegacy\r\n', revision: null }
  });
  expect(await port.read('empty.md')).toMatchObject({ status: 'found', document: { source: '' } });
});

it('uses the exact pending snapshot before a downloaded source', async () => {
  const db = database();
  await db.saveMarkdownDocument('note', 'older raw');
  const { saves } = await db.getSyncRepositories();
  await saves.save({
    id: 'pending',
    path: 'note.md',
    document: { version: 1, source: v1, card: v1Card },
    base: { kind: 'missing' },
    createOnly: true,
    createdAt: 0
  });
  expect(await new LocalNoteStorage(db).list()).toEqual({
    status: 'success',
    entries: [{ path: 'note.md', revision: null }]
  });
  expect(await new LocalNoteStorage(db).read('note.md')).toEqual({
    status: 'found',
    document: { path: 'note.md', source: v1, revision: null }
  });
});

it('keeps a Card-only filename visible as unavailable source rather than fabricating Markdown', async () => {
  const db = database();
  await db.saveCard(v1Card);
  const port = new LocalNoteStorage(db);
  expect(await port.list()).toEqual({
    status: 'success',
    entries: [{ path: 'test-card.md', revision: null }]
  });
  expect(await port.read('test-card.md')).toEqual({
    status: 'unavailable',
    reason: 'invalid-response'
  });
});

it('distinguishes an absent filename from a local failure', async () => {
  const db = database();
  const port = new LocalNoteStorage(db);
  expect(await port.read('absent.md')).toEqual({ status: 'not-found' });
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
    throw new DOMException('blocked', 'InvalidStateError');
  });
  expect(await port.list()).toEqual({ status: 'unavailable', reason: 'remote' });
  expect(await port.read('absent.md')).toEqual({ status: 'unavailable', reason: 'remote' });
});

it('validates a filename before accessing the database', async () => {
  const db = database();
  const open = vi.spyOn(indexedDB, 'open');
  expect(await new LocalNoteStorage(db).read('../other.md')).toEqual({
    status: 'invalid',
    reason: 'invalid-path'
  });
  expect(open).not.toHaveBeenCalled();
});

it.each(['abort after source read', 'transaction failure'])(
  'keeps the entire local inventory unavailable after %s',
  async failure => {
    const db = database();
    await db.saveMarkdownDocument('keep', 'local work');
    await db.saveMarkdownDocument('other', 'also keep');
    if (failure === 'abort after source read') {
      const getAll = IDBObjectStore.prototype.getAll;
      vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        const request = getAll.apply(this, args);
        if (this.name === 'markdownDocuments') {
          request.addEventListener('success', () => this.transaction.abort(), { once: true });
        }
        return request;
      });
    } else {
      vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => {
        throw new DOMException('Test storage failure', 'UnknownError');
      });
    }

    const local = Object.assign(new LocalNoteStorage(db), { id: 'local' });
    expect(await readStorageInventory([local])).toEqual([
      { storageId: 'local', status: 'unavailable' }
    ]);
  }
);

it('retains exact empty and unsupported sources while exposing a Card-only filename as unavailable', async () => {
  const db = database();
  await db.saveCard(v1Card);
  await db.saveMarkdownDocument('empty', '');
  const future = '<!-- markdown-cards: 99 -->\r\nKEEP';
  await db.saveMarkdownDocument('future', future);
  const local = Object.assign(new LocalNoteStorage(db), { id: 'local' });
  const inventory = await readStorageInventory([local]);
  expect(inventory).toEqual([
    {
      storageId: 'local',
      status: 'available',
      notes: [
        { path: 'test-card.md', status: 'unavailable' },
        { path: 'empty.md', status: 'present', source: '', revision: null },
        { path: 'future.md', status: 'present', source: future, revision: null }
      ]
    }
  ]);
});
