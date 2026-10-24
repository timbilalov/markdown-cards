import { LocalNoteStorage } from '../adapters/localNoteStorage';
import { readStorageInventory } from '../application/storageInventory';
import { describe, expect, it } from 'vitest';
import { DBService } from '../services/dbService';
import { createContextDatabase } from '../services/localStorageContexts';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import type { CardSaveDraft } from '../ports/cardSaveRepository';

const a = `ctx-v1-${'a'.repeat(64)}`;
const b = `ctx-v1-${'b'.repeat(64)}`;
const save: CardSaveDraft = {
  id: 'same-save',
  path: 'same.md',
  document: { version: 1, source: v1, card: v1Card },
  base: { kind: 'missing' },
  createOnly: true,
  createdAt: 10
};

// Exercise the same local adapter and inventory use case as storageManagement.
async function observe(database: DBService) {
  const [snapshot] = await readStorageInventory([
    Object.assign(new LocalNoteStorage(database), { id: 'local' })
  ]);
  return snapshot;
}

describe('context databases: actual IndexedDB isolation with existing repositories', () => {
  it('separates exact sources with equal filenames', async () => {
    const first = createContextDatabase(a);
    const second = createContextDatabase(b);
    await first.saveMarkdownDocument('same', v1);
    await second.saveMarkdownDocument('same', 'unsupported second source\r\n');
    expect(await observe(first)).toEqual({
      storageId: 'local',
      status: 'available',
      notes: [{ path: 'same.md', status: 'present', source: v1, revision: null }]
    });
    expect(await observe(second)).toEqual({
      storageId: 'local',
      status: 'available',
      notes: [
        {
          path: 'same.md',
          status: 'present',
          source: 'unsupported second source\r\n',
          revision: null
        }
      ]
    });
  });

  it('separates pending snapshots and outbox even for equal Save IDs', async () => {
    const first = createContextDatabase(a);
    const second = createContextDatabase(b);
    const firstRepos = await first.getSyncRepositories();
    const secondRepos = await second.getSyncRepositories();
    await firstRepos.saves.save(save);
    await secondRepos.saves.save({
      ...save,
      document: {
        version: 1,
        source: v1.replace('Карточка 🗂', 'Вторая карточка'),
        card: { ...v1Card, title: 'Вторая карточка' }
      }
    });
    expect((await firstRepos.saves.readCurrent('same.md')).draft?.source).toBe(v1);
    expect((await secondRepos.saves.readCurrent('same.md')).draft?.source).toContain(
      'Вторая карточка'
    );
    expect((await firstRepos.outbox.list()).map(row => row.id)).toEqual(['same-save']);
    expect((await secondRepos.outbox.list()).map(row => row.id)).toEqual(['same-save']);
    expect((await first.getCard(v1Card.meta.id))?.title).toBe(v1Card.title);
    expect((await second.getCard(v1Card.meta.id))?.title).toBe('Вторая карточка');
  });

  it('reopens a context without changing another context or the legacy database', async () => {
    const first = createContextDatabase(a);
    await first.saveMarkdownDocument('same', v1);
    const legacy = new DBService();
    await legacy.saveMarkdownDocument('same', 'legacy text');
    const reopened = createContextDatabase(a);
    const other = createContextDatabase(b);
    expect(await observe(reopened)).toEqual({
      storageId: 'local',
      status: 'available',
      notes: [{ path: 'same.md', status: 'present', source: v1, revision: null }]
    });
    expect(await observe(other)).toEqual({ storageId: 'local', status: 'available', notes: [] });
    expect((await legacy.getMarkdownDocument('same'))?.result).toMatchObject({
      source: 'legacy text'
    });
  });

  it('does not assign v5 cached text or pending work to the first opened cloud context', async () => {
    const legacy = new DBService();
    await legacy.saveMarkdownDocument('cached', 'legacy exact\r\n');
    await (await legacy.getSyncRepositories()).saves.save(save);
    const fresh = createContextDatabase(b);
    expect(await observe(fresh)).toEqual({ storageId: 'local', status: 'available', notes: [] });
    expect(await (await fresh.getSyncRepositories()).outbox.list()).toEqual([]);
    expect(
      (await (await legacy.getSyncRepositories()).saves.readCurrent('same.md')).draft?.source
    ).toBe(v1);
    expect((await (await legacy.getSyncRepositories()).outbox.list())[0]).toMatchObject({
      id: 'same-save',
      state: { status: 'pending' }
    });
    const inventory = await observe(legacy);
    expect(inventory).toEqual({
      storageId: 'local',
      status: 'available',
      notes: expect.arrayContaining([
        { path: 'cached.md', status: 'present', source: 'legacy exact\r\n', revision: null },
        { path: 'same.md', status: 'present', source: v1, revision: null }
      ])
    });
    expect(inventory.status === 'available' && inventory.notes).toHaveLength(2);
  });

  it('clears only the explicitly addressed context', async () => {
    const first = createContextDatabase(a);
    const second = createContextDatabase(b);
    await first.saveMarkdownDocument('same', 'first');
    await second.saveMarkdownDocument('same', 'second');
    await first.clearAllData();
    expect(await observe(first)).toEqual({ storageId: 'local', status: 'available', notes: [] });
    expect(await observe(second)).toEqual({
      storageId: 'local',
      status: 'available',
      notes: [{ path: 'same.md', status: 'present', source: 'second', revision: null }]
    });
  });

  it.each(['', 'legacy', 'ctx-v1-../outside', `ctx-v1-${'g'.repeat(64)}`])(
    'rejects invalid context %j',
    id => {
      expect(() => createContextDatabase(id)).toThrow(/^Invalid storage context$/);
    }
  );
});
