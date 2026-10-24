import { historicalContextDatabase, historicalLocalId } from './helpers/historicalStorageContext';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';
import { installWebLocks } from './helpers/webLocks';
import { LocalNoteStorage } from '../adapters/localNoteStorage';
import { OLD_SOURCE, NEW_SOURCE } from './helpers/storageSyncFixtures';
import { browserStorageDescriptor as descriptor } from './helpers/browserStorageContext';

let http: ReturnType<typeof mockHttp>;
let remote: string;
let upload: import('vitest').Mock<(init?: RequestInit) => Promise<Response>>;
beforeEach(() => {
  vi.resetModules();
  installWebLocks();
  http = mockHttp();
  remote = NEW_SOURCE;
  upload = vi.fn(async (init?: RequestInit) => {
    remote = new TextDecoder('utf8', { ignoreBOM: true }).decode(init?.body as Uint8Array);
    return Response.json({ status: 'written', revision: null });
  });
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: 'yandex', storages: [descriptor] })
  );
  http.on('GET', '/api/storages/yandex/files', () =>
    Response.json({ _embedded: { items: [{ name: 'note.md', path: 'note.md' }] } })
  );
  http.on(
    'GET',
    '/api/storages/yandex/download?path=note.md',
    () => new Response(new TextEncoder().encode(remote))
  );
  http.on('POST', '/api/storages/yandex/copy?path=note.md', upload);
});

afterEach(() => http.assertHandled());

async function setup() {
  const db = await historicalContextDatabase();
  await db.saveMarkdownDocument('note', OLD_SOURCE);
  const model = await (await import('../services/storageManagement')).loadStorageComparison();
  const manual = await import('../services/manualStorageSync');
  return { db, model, manual };
}

it('composes arbitrary local/cloud ports and executes an explicitly older local reference without rebinding app DB', async () => {
  const dbModule = await import('../services/dbService');
  await dbModule.dbService.saveMarkdownDocument('runtime-only', 'normal runtime source');
  const { db, model, manual } = await setup();
  const plan = manual.prepareStorageSync(model, {
    paths: ['note.md'],
    sourceStorageId: historicalLocalId,
    targetStorageIds: ['yandex']
  });
  expect(plan?.actions).toMatchObject([{ status: 'copy', source: OLD_SOURCE }]);
  expect(upload).not.toHaveBeenCalled();
  expect(await manual.runStorageSync(model, plan)).toMatchObject([
    { path: 'note.md', targetStorageId: 'yandex', outcome: { status: 'written' } }
  ]);
  expect(remote).toBe(OLD_SOURCE);
  expect((await dbModule.dbService.getMarkdownDocument('runtime-only'))?.result).toMatchObject({
    source: 'normal runtime source'
  });
  expect(await new LocalNoteStorage(db).read('note.md')).toMatchObject({
    status: 'found',
    document: { source: OLD_SOURCE }
  });
});

it('writes the chosen cloud reference to a protected local source and preserves displaced raw source in archive', async () => {
  const { db, model, manual } = await setup();
  const plan = manual.prepareStorageSync(model, {
    paths: ['note.md'],
    sourceStorageId: 'yandex',
    targetStorageIds: [historicalLocalId]
  });
  expect(await manual.runStorageSync(model, plan)).toMatchObject([
    { outcome: { status: 'written' } }
  ]);
  expect((await (await db.getSyncRepositories()).saves.readCurrent('note.md')).draft?.source).toBe(
    NEW_SOURCE
  );
  expect((await manual.readManualSyncState())?.archives).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ remote: { filename: 'note', source: OLD_SOURCE } })
    ])
  );
  expect(upload).not.toHaveBeenCalled();
});

it('keeps unknown intent durable, blocks retry and can verify the exact desired result without another upload', async () => {
  const { model, manual } = await setup();
  http.on('POST', '/api/storages/yandex/copy?path=note.md', async init => {
    await upload(init);
    throw new Error('lost response');
  });
  const plan = manual.prepareStorageSync(model, {
    paths: ['note.md'],
    sourceStorageId: historicalLocalId,
    targetStorageIds: ['yandex']
  });
  expect(await manual.runStorageSync(model, plan)).toMatchObject([
    { outcome: { status: 'unavailable', outcome: 'unknown' } }
  ]);
  const pending = (await manual.readManualSyncState())?.pending[0];
  expect(pending).toMatchObject({ source: OLD_SOURCE, state: 'unknown' });
  const refreshed = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(await manual.verifyManualSync(refreshed, pending)).toBe('confirmed');
  expect((await manual.readManualSyncState())?.pending).toEqual([]);
  expect(upload).toHaveBeenCalledTimes(1);
});

it('retains a different or unreadable unknown result and never repeats a write during verification', async () => {
  const { model, manual } = await setup();
  http.on('POST', '/api/storages/yandex/copy?path=note.md', async () => {
    throw new Error('lost');
  });
  const plan = manual.prepareStorageSync(model, {
    paths: ['note.md'],
    sourceStorageId: historicalLocalId,
    targetStorageIds: ['yandex']
  });
  await manual.runStorageSync(model, plan);
  const pending = (await manual.readManualSyncState())?.pending[0];
  expect(pending).toBeDefined();
  expect(await manual.verifyManualSync(model, pending)).toBe('different');
  http.on(
    'GET',
    '/api/storages/yandex/download?path=note.md',
    () => new Response(null, { status: 503 })
  );
  expect(await manual.verifyManualSync(model, pending)).toBe('unavailable');
  expect((await manual.readManualSyncState())?.pending).toHaveLength(1);
});

it('does not verify or dismiss an old-context intent using a newly configured target with the same ID', async () => {
  const { model, manual } = await setup();
  const operation = {
    id: 'old',
    targetKey: `cloud:ctx-v1-${'d'.repeat(64)}`,
    pathKey: 'note.md',
    path: 'note.md',
    sourceStorageId: historicalLocalId,
    targetStorageId: 'yandex',
    source: OLD_SOURCE,
    startedAt: 1
  };
  const { IndexedDbManualSyncJournal } = await import('../adapters/indexedDb/manualSyncJournal');
  const journal = new IndexedDbManualSyncJournal();
  await journal.begin(operation);
  expect(await manual.verifyManualSync(model, operation)).toBe('unavailable');
  expect(await manual.dismissManualSync(model, operation)).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  expect(await journal.list()).toHaveLength(1);
});

it('explicitly dismisses an intent into durable history without upload or loss of its exact source', async () => {
  const { model, manual } = await setup();
  http.on('POST', '/api/storages/yandex/copy?path=note.md', async () => {
    throw new Error('lost');
  });
  await manual.runStorageSync(
    model,
    manual.prepareStorageSync(model, {
      paths: ['note.md'],
      sourceStorageId: historicalLocalId,
      targetStorageIds: ['yandex']
    })
  );
  const pending = (await manual.readManualSyncState())?.pending[0];
  expect(pending).toBeDefined();
  expect(await manual.dismissManualSync(model, pending)).toBe(true);
  expect((await manual.readManualSyncState())?.pending).toEqual([]);
  expect((await manual.readManualSyncState())?.history).toEqual([
    expect.objectContaining({ id: pending.id, source: OLD_SOURCE })
  ]);
  expect(upload).not.toHaveBeenCalled();
});

it.each(['verify', 'dismiss'] as const)(
  'protects an ordinary Save made during unknown copy before %s clears its barrier',
  async action => {
    const { model, manual } = await setup();
    const { createContextDatabase } = await import('../services/localStorageContexts');
    const database = createContextDatabase(descriptor.contextId);
    const repositories = await database.getSyncRepositories();
    const { v1, v1Card } = await import('./helpers/markdownReadFixtures');
    http.on('POST', '/api/storages/yandex/copy?path=note.md', async init => {
      await upload(init);
      await repositories.saves.save({
        id: 'during-copy',
        path: 'note.md',
        document: { version: 1, source: v1, card: v1Card },
        base: { kind: 'present', revision: null },
        baseSource: OLD_SOURCE,
        createOnly: false,
        createdAt: 1
      });
      throw new Error('lost');
    });
    await manual.runStorageSync(
      model,
      manual.prepareStorageSync(model, {
        paths: ['note.md'],
        sourceStorageId: historicalLocalId,
        targetStorageIds: ['yandex']
      })
    );
    const pending = (await manual.readManualSyncState())?.pending[0];
    expect(pending).toBeDefined();
    expect(
      action === 'verify'
        ? await manual.verifyManualSync(model, pending)
        : await manual.dismissManualSync(model, pending)
    ).toBe(action === 'verify' ? 'confirmed' : true);
    expect((await repositories.saves.readCurrent('note.md')).draft).toEqual({
      filename: 'note',
      source: v1,
      saveMode: 'update'
    });
    expect((await manual.readManualSyncState())?.archives.flatMap(row => row.operations)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'during-copy', source: v1 })])
    );
    vi.resetModules();
    const { initializeTestStorage } = await import('./helpers/browserStorageContext');
    await initializeTestStorage(http);
    expect(await (await (await import('../services/cardSyncRuntime')).getCardSync()).retry()).toBe(
      'synced'
    );
    expect(http.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/cloud/'))).toBe(
      false
    );
    expect(upload).toHaveBeenCalledTimes(1);
  }
);

it.each(['verify', 'dismiss'] as const)(
  'refuses %s without cross-tab ownership and retains pending without file I/O',
  async action => {
    const { model, manual } = await setup();
    http.on('POST', '/api/storages/yandex/copy?path=note.md', async () => {
      throw new Error('lost');
    });
    await manual.runStorageSync(
      model,
      manual.prepareStorageSync(model, {
        paths: ['note.md'],
        sourceStorageId: historicalLocalId,
        targetStorageIds: ['yandex']
      })
    );
    const pending = (await manual.readManualSyncState())?.pending[0];
    expect(pending).toBeDefined();
    const calls = http.fetch.mock.calls.length;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    expect(
      action === 'verify'
        ? await manual.verifyManualSync(model, pending)
        : await manual.dismissManualSync(model, pending)
    ).toBe(action === 'verify' ? 'unavailable' : false);
    expect(http.fetch.mock.calls).toHaveLength(calls);
    expect((await manual.readManualSyncState())?.pending).toHaveLength(1);
  }
);

it('uses the durable intent source and refuses stale recovery instead of trusting mutable UI data', async () => {
  const { model, manual } = await setup();
  http.on('POST', '/api/storages/yandex/copy?path=note.md', async () => {
    throw new Error('lost');
  });
  await manual.runStorageSync(
    model,
    manual.prepareStorageSync(model, {
      paths: ['note.md'],
      sourceStorageId: historicalLocalId,
      targetStorageIds: ['yandex']
    })
  );
  const pending = (await manual.readManualSyncState())?.pending[0];
  expect(pending).toBeDefined();
  expect(await manual.verifyManualSync(model, { ...pending, source: NEW_SOURCE })).toBe(
    'different'
  );
  const { IndexedDbManualSyncJournal } = await import('../adapters/indexedDb/manualSyncJournal');
  const journal = new IndexedDbManualSyncJournal();
  await journal.settle(pending, 'known');
  await journal.begin({ ...pending, id: 'new-intent', source: 'new source' });
  expect(await manual.verifyManualSync(model, pending)).toBe('unavailable');
  expect(await manual.dismissManualSync(model, pending)).toBe(false);
  expect((await journal.list())[0].id).toBe('new-intent');
});

it('retains pending when durable local finalization fails after a matching cloud read', async () => {
  const { model, manual } = await setup();
  http.on('POST', '/api/storages/yandex/copy?path=note.md', async init => {
    await upload(init);
    throw new Error('lost');
  });
  await manual.runStorageSync(
    model,
    manual.prepareStorageSync(model, {
      paths: ['note.md'],
      sourceStorageId: historicalLocalId,
      targetStorageIds: ['yandex']
    })
  );
  const pending = (await manual.readManualSyncState())?.pending[0];
  expect(pending).toBeDefined();
  const { IndexedDbManualLocalStorage } = await import('../adapters/indexedDb/manualLocalStorage');
  vi.spyOn(IndexedDbManualLocalStorage.prototype, 'finishCloud').mockRejectedValue(
    new Error('quota')
  );
  expect(await manual.verifyManualSync(model, pending)).toBe('unavailable');
  expect((await manual.readManualSyncState())?.pending).toHaveLength(1);
});

it('surfaces failed archive/journal reads instead of reporting empty recovery state', async () => {
  const { manual } = await setup();
  const { IndexedDbManualSyncJournal } = await import('../adapters/indexedDb/manualSyncJournal');
  vi.spyOn(IndexedDbManualSyncJournal.prototype, 'list').mockRejectedValue(
    new Error('journal failed')
  );
  await expect(manual.readManualSyncState()).rejects.toThrow();
});

it.each(['source', 'target'] as const)(
  'refuses a preview after the %s physical context changes even when path/bytes/revision match',
  async side => {
    const { model, manual } = await setup();
    const plan = manual.prepareStorageSync(model, {
      paths: ['note.md'],
      sourceStorageId: side === 'source' ? 'yandex' : historicalLocalId,
      targetStorageIds: [side === 'source' ? historicalLocalId : 'yandex']
    });
    http.on('GET', '/api/storages', () =>
      Response.json({
        activeStorageId: 'yandex',
        storages: [{ ...descriptor, contextId: `ctx-v1-${'f'.repeat(64)}` }]
      })
    );
    const refreshed = await (await import('../services/storageManagement')).loadStorageComparison();
    expect(await manual.runStorageSync(refreshed, plan)).toMatchObject([
      { outcome: { status: 'blocked', reason: 'context-changed' } }
    ]);
    expect(upload).not.toHaveBeenCalled();
  }
);

it('waits out an ordinary delivery, rejects its stale preview and copies an older reference only after a fresh selection', async () => {
  const { initializeTestStorage } = await import('./helpers/browserStorageContext');
  await initializeTestStorage(http);
  const db = (await import('../services/dbService')).dbService;
  const repositories = await db.getSyncRepositories();
  const { v1, v1Card } = await import('./helpers/markdownReadFixtures');
  const historical = await historicalContextDatabase();
  await historical.saveMarkdownDocument('note', OLD_SOURCE);
  http.on('GET', '/api/cloud/files', () =>
    Response.json({ _embedded: { items: [{ name: 'note.md', path: 'note.md' }] } })
  );
  http.on('GET', '/api/cloud/download?path=note.md', () => new Response(remote));
  const started = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  http.on('POST', '/api/cloud/upload', async () => {
    remote = v1;
    started.resolve();
    await ack.promise;
    return new Response('OK');
  });
  const { manual, model } = await setup();
  const preview = manual.prepareStorageSync(model, {
    paths: ['note.md'],
    sourceStorageId: historicalLocalId,
    targetStorageIds: ['yandex']
  });
  await repositories.saves.save({
    id: 'inflight',
    path: 'note.md',
    document: { version: 1, source: v1, card: v1Card },
    base: { kind: 'present', revision: null },
    baseSource: NEW_SOURCE,
    createOnly: false,
    createdAt: 1
  });
  const ordinary = await (await import('../services/cardSyncRuntime')).getCardSync();
  const delivering = ordinary.retry();
  await started.promise;
  expect(await manual.runStorageSync(model, preview)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'busy' } }
  ]);
  expect(upload).not.toHaveBeenCalled();
  ack.resolve();
  expect(await delivering).toBe('synced');
  expect(await manual.runStorageSync(model, preview)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'target-changed' } }
  ]);
  expect(upload).not.toHaveBeenCalled();
  const refreshed = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(
    await manual.runStorageSync(
      refreshed,
      manual.prepareStorageSync(refreshed, {
        paths: ['note.md'],
        sourceStorageId: historicalLocalId,
        targetStorageIds: ['yandex']
      })
    )
  ).toMatchObject([{ outcome: { status: 'written' } }]);
  expect(remote).toBe(OLD_SOURCE);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(await ordinary.retry()).toBe('synced');
  expect(remote).toBe(OLD_SOURCE);
});
