import { LocalNoteStorage } from '../adapters/localNoteStorage';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';
import { installWebLocks } from './helpers/webLocks';
import { v1, v1Card } from './helpers/markdownReadFixtures';

const main = {
  id: 'main',
  label: 'Главное',
  provider: 'yandex',
  status: 'available',
  contextId: `ctx-v1-${'a'.repeat(64)}`,
  capabilities: { revisions: false, conditionalCreate: true }
};

const reserve = { ...main, id: 'reserve', label: 'Резерв', contextId: `ctx-v1-${'b'.repeat(64)}` };

const old = { ...main, id: 'old', label: 'Прежнее', contextId: `ctx-v1-${'c'.repeat(64)}` };
const localId = (entry: typeof main) => `local:${entry.contextId}`;
let http: ReturnType<typeof mockHttp>;
beforeEach(async () => {
  vi.resetModules();
  installWebLocks();
  http = mockHttp();
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: main.id, storages: [main, reserve] })
  );
  await (await import('../services/storageSession')).initializeStorageSession(true);
  await (await import('../services/storageSession')).rememberStorageContexts([old]);
});

afterEach(() => http.assertHandled());

const catalog = () => ({
  catalogError: null,
  columns: [main, reserve].map(entry => ({
    id: entry.id,
    label: entry.label,
    kind: 'cloud' as const,
    contextId: entry.contextId,
    active: entry.id === main.id
  }))
});
const service = () => import('../services/localCacheManagement');
const database = async (entry: typeof main) =>
  (await import('../services/localStorageContexts')).createContextDatabase(entry.contextId);

it('distinguishes active, reserve and historical caches and counts local work', async () => {
  const db = await database(old);
  await db.saveMarkdownDocument('note', 'old cloud source');
  await (
    await db.getSyncRepositories()
  ).saves.save({
    id: 'save',
    path: 'note.md',
    document: { version: 1, source: v1, card: v1Card },
    base: { kind: 'missing' },
    createOnly: true,
    createdAt: 1
  });
  const caches = await (await service()).readLocalCaches(catalog());
  expect(Array.isArray(caches)).toBe(true);
  expect(caches.find(row => row.id === localId(main))).toMatchObject({
    status: 'active',
    blockedReason: expect.any(String)
  });
  expect(caches.find(row => row.id === localId(reserve))).toMatchObject({
    status: 'reserve',
    blockedReason: null
  });
  expect(caches.find(row => row.id === localId(old))).toMatchObject({
    status: 'historical',
    contents: { notes: 1, drafts: 1, pendingOperations: 1 },
    blockedReason: null
  });
  expect(caches).toHaveLength(3);
});

it('deletes only the selected historical database and forgets it across reload', async () => {
  const db = await database(old);
  await db.saveMarkdownDocument('keep', 'old');
  const active = await database(main);
  await active.saveMarkdownDocument('keep', 'main');
  expect(await (await service()).deleteLocalCache(localId(old), vi.fn())).toEqual({
    status: 'deleted'
  });
  expect(
    (await indexedDB.databases()).some(row => row.name === `MarkdownCardsDB:${old.contextId}`)
  ).toBe(false);
  vi.resetModules();
  const contexts = await (await import('../services/storageSession')).listLocalStorageContexts();
  expect(contexts.map(row => row.id)).not.toContain(localId(old));
  expect(await new LocalNoteStorage(active).read('keep.md')).toMatchObject({
    status: 'found',
    document: { source: 'main' }
  });
});

it('keeps a removed reserve suppressed on inventory refresh and restores it only on explicit use', async () => {
  const session = await import('../services/storageSession');
  expect(await (await service()).deleteLocalCache(localId(reserve), vi.fn())).toEqual({
    status: 'deleted'
  });
  await session.rememberStorageContexts([main, reserve]);
  expect((await session.listLocalStorageContexts()).map(row => row.id)).not.toContain(
    localId(reserve)
  );
  await session.rememberStorageContexts([reserve], true);
  expect((await session.listLocalStorageContexts()).map(row => row.id)).toContain(localId(reserve));
});

it('protects the runtime cache even after the server active context changes', async () => {
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: reserve.id, storages: [reserve] })
  );
  const deletion = vi.spyOn(indexedDB, 'deleteDatabase');
  expect(await (await service()).deleteLocalCache(localId(main), vi.fn())).toMatchObject({
    status: 'blocked'
  });
  expect(await (await service()).deleteLocalCache(localId(reserve), vi.fn())).toMatchObject({
    status: 'blocked'
  });
  expect(deletion).not.toHaveBeenCalled();
});

it('does not delete when the catalog cannot confirm the active connection', async () => {
  http.on('GET', '/api/storages', () => new Response(null, { status: 503 }));
  const deletion = vi.spyOn(indexedDB, 'deleteDatabase');
  expect(await (await service()).deleteLocalCache(localId(old), vi.fn())).toMatchObject({
    status: 'blocked'
  });
  expect(deletion).not.toHaveBeenCalled();
});

it('protects caches with a pending manual write to their local or cloud destination', async () => {
  const { IndexedDbManualSyncJournal } = await import('../adapters/indexedDb/manualSyncJournal');
  for (const [entry, kind] of [
    [old, 'local'],
    [reserve, 'cloud']
  ] as const) {
    await new IndexedDbManualSyncJournal().begin({
      id: kind,
      targetKey: `${kind}:${entry.contextId}`,
      pathKey: 'note.md',
      path: 'note.md',
      sourceStorageId: 'main',
      targetStorageId: kind === 'local' ? localId(entry) : entry.id,
      source: v1,
      startedAt: 1
    });
    expect(await (await service()).deleteLocalCache(localId(entry), vi.fn())).toMatchObject({
      status: 'blocked'
    });
  }
});

it('does not delete during another sync operation', async () => {
  await navigator.locks.request('markdown-cards-sync', { mode: 'exclusive' }, async () => {
    expect(await (await service()).deleteLocalCache(localId(old), vi.fn())).toMatchObject({
      status: 'blocked'
    });
  });
  expect(
    (await (await import('../services/storageSession')).listLocalStorageContexts()).map(
      row => row.id
    )
  ).toContain(localId(old));
});

it('waits for a foreign open connection instead of reporting a failed deletion that can later succeed', async () => {
  await (await database(old)).init();
  const held = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`MarkdownCardsDB:${old.contextId}`, 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const blocked = vi.fn();
  let settled = false;
  const deleting = (await service()).deleteLocalCache(localId(old), blocked).then(result => {
    settled = true;
    return result;
  });
  try {
    await vi.waitFor(() => expect(blocked).toHaveBeenCalled());
    expect(settled).toBe(false);
  } finally {
    held.close();
  }
  expect(await deleting).toEqual({ status: 'deleted' });
});

it('leaves the manifest and source intact when deletion fails', async () => {
  const db = await database(old);
  await db.saveMarkdownDocument('note', 'keep exact');
  vi.spyOn(
    (await import('../services/dbService')).DBService.prototype,
    'deleteLocalCache'
  ).mockRejectedValueOnce(new Error('storage failure'));
  await expect((await service()).deleteLocalCache(localId(old), vi.fn())).rejects.toThrow(
    'storage failure'
  );
  expect(
    (await (await import('../services/storageSession')).listLocalStorageContexts()).map(
      row => row.id
    )
  ).toContain(localId(old));
  expect(await new LocalNoteStorage(db).read('note.md')).toMatchObject({
    status: 'found',
    document: { source: 'keep exact' }
  });
});

it('protects an unavailable configured connection and refuses unknown cache identifiers', async () => {
  http.on('GET', '/api/storages', () =>
    Response.json({
      activeStorageId: main.id,
      storages: [
        main,
        { id: reserve.id, label: reserve.label, provider: reserve.provider, status: 'unavailable' }
      ]
    })
  );
  const deletion = vi.spyOn(indexedDB, 'deleteDatabase');
  for (const id of [localId(reserve), 'local:../../another-database'])
    expect(await (await service()).deleteLocalCache(id, vi.fn())).toMatchObject({
      status: 'blocked'
    });
  expect(deletion).not.toHaveBeenCalled();
});

it('requires cross-tab ownership before checking or deleting data', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const deletion = vi.spyOn(indexedDB, 'deleteDatabase');
  http.fetch.mockClear();
  expect(await (await service()).deleteLocalCache(localId(old), vi.fn())).toMatchObject({
    status: 'blocked',
    reason: expect.stringContaining('Web Locks')
  });
  expect(deletion).not.toHaveBeenCalled();
  expect(http.fetch).not.toHaveBeenCalled();
});

it('keeps a former active tab open until it releases its cache', async () => {
  const original = await import('../services/dbService');
  let held: IDBDatabase | undefined;
  const open = indexedDB.open.bind(indexedDB);
  const observe = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
    const request = open(...args);
    if (args[0] === `MarkdownCardsDB:${main.contextId}`)
      request.addEventListener(
        'success',
        () => {
          held = request.result;
        },
        { once: true }
      );
    return request;
  });
  await original.dbService.init();
  observe.mockRestore();
  vi.resetModules();
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: reserve.id, storages: [reserve] })
  );
  await (await import('../services/storageSession')).initializeStorageSession(true);
  const blocked = vi.fn();
  const deleting = (await service()).deleteLocalCache(localId(main), blocked);
  try {
    await vi.waitFor(() => expect(blocked).toHaveBeenCalled());
    expect(held?.name).toBe(`MarkdownCardsDB:${main.contextId}`);
  } finally {
    held?.close();
  }
  expect(await deleting).toEqual({ status: 'deleted' });
});
