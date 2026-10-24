import { CardSync } from '../application/cardSync';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import { expect, it, vi } from 'vitest';
import { DBService } from '../services/dbService';
import { LocalNoteStorage } from '../adapters/localNoteStorage';
import { OLD_SOURCE } from './helpers/storageSyncFixtures';
import { v1, v1Card } from './helpers/markdownReadFixtures';

async function setup() {
  const database = new DBService();
  await database.saveMarkdownDocument('note', 'cached');
  const repositories = await database.getSyncRepositories();
  const saved = await repositories.saves.save({
    id: 'pending',
    path: 'note.md',
    document: { version: 1, source: v1, card: v1Card },
    base: { kind: 'present', revision: 'old' },
    baseSource: 'cached',
    createOnly: false,
    createdAt: 1
  });
  const manual = await database.getManualSyncRepository();
  return { database, manual, repositories, saved };
}

it('atomically preserves local work and replaces it with an exact protected raw snapshot', async () => {
  const { database, manual, repositories, saved } = await setup();
  const source = '\uFEFFunsupported\r\n';
  expect(
    await manual.copy({
      path: 'note.md',
      source,
      expectedTarget: { status: 'present', source: v1, revision: null }
    })
  ).toEqual({ status: 'written', revision: null });
  expect(await new LocalNoteStorage(database).read('note.md')).toMatchObject({
    document: { source }
  });
  expect((await repositories.saves.readCurrent('note.md')).draft).toEqual({
    filename: 'note',
    source,
    saveMode: 'update'
  });
  expect(await repositories.outbox.list()).toEqual([]);
  expect(await manual.archives()).toEqual([
    expect.objectContaining({
      path: 'note.md',
      draft: expect.objectContaining({ source: v1, saveId: 'pending' }),
      remote: { filename: 'note', source: 'cached' },
      operations: [saved]
    })
  ]);
});

it('does not replace a newly edited local source using stale expectations', async () => {
  const { manual, repositories } = await setup();
  expect(
    await manual.copy({
      path: 'note.md',
      source: OLD_SOURCE,
      expectedTarget: { status: 'present', source: 'cached', revision: null }
    })
  ).toEqual({ status: 'conflict' });
  expect((await repositories.saves.readCurrent('note.md')).draft?.source).toBe(v1);
  expect(await manual.archives()).toEqual([]);
});

it('creates a missing empty source without manufacturing Card data', async () => {
  const database = new DBService();
  const manual = await database.getManualSyncRepository();
  expect(
    await manual.copy({ path: 'empty.md', source: '', expectedTarget: { status: 'missing' } })
  ).toEqual({ status: 'written', revision: null });
  expect(await new LocalNoteStorage(database).read('empty.md')).toMatchObject({
    document: { source: '' }
  });
  expect(await database.getAllCards()).toEqual([]);
});

it('quarantines pending delivery before a manual cloud write while preserving its original evidence', async () => {
  const { manual, repositories, saved } = await setup();
  expect(await manual.prepareCloud('note.md')).toBe('ready');
  expect((await repositories.outbox.list())[0].state).toEqual({ status: 'conflict' });
  expect((await manual.archives())[0].operations).toEqual([saved]);
  expect((await repositories.saves.readCurrent('note.md')).draft?.source).toBe(v1);
});

it.each(['processing', 'uncertain'] as const)(
  'blocks manual cloud replacement over an unresolved %s ordinary delivery',
  async state => {
    const { manual, repositories } = await setup();
    await repositories.outbox.apply('pending', { type: 'start', deliveryId: 'delivery', now: 2 });
    if (state === 'uncertain') await repositories.outbox.apply('pending', { type: 'recover' });
    expect(await manual.prepareCloud('note.md')).toBe('uncertain');
    expect(await manual.archives()).toEqual([]);
  }
);

it('retires quarantined work after a confirmed cloud copy and retains different local work without automatic replay', async () => {
  const { manual, repositories } = await setup();
  await manual.prepareCloud('note.md');
  await manual.finishCloud('note.md', 'selected older reference');
  expect(await repositories.outbox.list()).toEqual([]);
  expect(await repositories.saves.readCurrent('note.md')).toMatchObject({
    remote: { source: 'selected older reference' },
    draft: { source: v1, saveMode: 'update' }
  });
  expect((await repositories.saves.readCurrent('note.md')).draft?.saveId).toBeUndefined();
});

it('captures a new Save committed during manual cloud I/O instead of allowing it to undo the selected reference', async () => {
  const { manual, repositories, saved } = await setup();
  await manual.prepareCloud('note.md');
  await repositories.saves.save({
    id: 'during-network',
    path: 'note.md',
    document: { version: 1, source: OLD_SOURCE, card: v1Card },
    base: { kind: 'missing' },
    createOnly: true,
    createdAt: 5
  });
  await manual.finishCloud('note.md', 'reference');
  expect(await repositories.outbox.list()).toEqual([]);
  expect((await repositories.saves.readCurrent('note.md')).draft).toEqual({
    filename: 'note',
    source: OLD_SOURCE,
    saveMode: 'update'
  });
  expect((await manual.archives()).flatMap(row => row.operations).map(row => row.id)).toEqual(
    expect.arrayContaining([saved.id, 'during-network'])
  );
});

it('acknowledges a matching local draft after manual cloud success', async () => {
  const { manual, repositories } = await setup();
  await manual.prepareCloud('note.md');
  await manual.finishCloud('note.md', v1);
  expect(await repositories.saves.readCurrent('note.md')).toMatchObject({
    draft: null,
    operation: null,
    remote: { source: v1 }
  });
});

it('rolls back archive, draft and queue together if local replacement fails', async () => {
  const { manual, repositories, saved } = await setup();
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === 'localMarkdownSnapshots')
      throw new DOMException('quota', 'QuotaExceededError');
    return put.apply(this, args);
  });
  await expect(
    manual.copy({
      path: 'note.md',
      source: 'new',
      expectedTarget: { status: 'present', source: v1, revision: null }
    })
  ).rejects.toThrow();
  expect((await repositories.saves.readCurrent('note.md')).draft?.source).toBe(v1);
  expect(await repositories.outbox.list()).toEqual([saved]);
  expect(await manual.archives()).toEqual([]);
});

it('rejects malformed local paths without modifying data', async () => {
  const { manual, repositories, saved } = await setup();
  expect(
    await manual.copy({ path: '../bad.md', source: 'new', expectedTarget: { status: 'missing' } })
  ).toEqual({ status: 'invalid', reason: 'invalid-path' });
  expect(await repositories.outbox.list()).toEqual([saved]);
});

it.each(['processing', 'uncertain'] as const)(
  'does not clear a %s ordinary-delivery barrier by copying only to its local cache',
  async state => {
    const { manual, repositories } = await setup();
    await repositories.outbox.apply('pending', { type: 'start', deliveryId: 'delivery', now: 2 });
    if (state === 'uncertain') await repositories.outbox.apply('pending', { type: 'recover' });
    expect(
      await manual.copy({
        path: 'note.md',
        source: 'reference',
        expectedTarget: { status: 'present', source: v1, revision: null }
      })
    ).toEqual({ status: 'conflict' });
    expect((await repositories.outbox.read('pending'))?.state.status).toBe(state);
    await repositories.saves.save({
      id: 'new-save',
      path: 'note.md',
      document: { version: 1, source: v1, card: v1Card },
      base: { kind: 'missing' },
      createOnly: true,
      createdAt: 5
    });
    const cloud = new MemoryCloudStorage();
    const write = vi.spyOn(cloud, 'write');
    const sync = new CardSync({
      ...repositories,
      cloud,
      readCards: async () => [],
      readSource: async () => null,
      refresh: async () => {
        throw new Error('unused');
      },
      now: () => 10,
      newId: () => crypto.randomUUID(),
      checkIsOnline: () => true,
      exclusive: async task => {
        await task();
        return true;
      }
    });
    expect(await sync.retry()).toBe('uncertain');
    expect(write).not.toHaveBeenCalled();
  }
);
