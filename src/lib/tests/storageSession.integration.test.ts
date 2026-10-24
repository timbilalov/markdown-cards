import { LocalNoteStorage } from '../adapters/localNoteStorage';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { mockHttp } from './helpers/http';
import { createContextDatabase } from '../services/localStorageContexts';

vi.mock('$app/environment', () => ({ browser: true }));

const main = {
  id: 'main',
  label: 'Главное',
  provider: 'yandex',
  contextId: `ctx-v1-${'a'.repeat(64)}`,
  capabilities: { revisions: false, conditionalCreate: true },
  status: 'available'
};

const other = { ...main, id: 'other', label: 'Другое', contextId: `ctx-v1-${'b'.repeat(64)}` };
let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  vi.resetModules();
  http = mockHttp();
});

afterEach(() => http.assertHandled());

function catalog(active = main) {
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: active.id, storages: [active] })
  );
}

it('preserves a known cache folder when a later descriptor omits display metadata', async () => {
  const module = await import('../services/storageSession');
  await module.rememberStorageContexts([{ ...main, rootPath: 'disk:/Original' }]);
  await module.rememberStorageContexts([main]);
  expect(
    (await module.listLocalStorageContexts()).find(local => local.contextId === main.contextId)
  ).toMatchObject({ rootPath: 'disk:/Original' });
});

it('lists only caches attached to a verified storage context', async () => {
  catalog();
  const module = await import('../services/storageSession');
  await module.initializeStorageSession(true);
  expect((await module.listLocalStorageContexts()).map(entry => entry.contextId)).toEqual([
    main.contextId
  ]);
});

it('remembers old local contexts across reload and server catalog removal', async () => {
  catalog();
  let module = await import('../services/storageSession');
  await module.initializeStorageSession(true);
  await createContextDatabase(main.contextId).saveMarkdownDocument('note', 'old context raw');
  vi.resetModules();
  catalog(other);
  module = await import('../services/storageSession');
  await module.initializeStorageSession(true);
  const locals = await module.listLocalStorageContexts();
  expect(locals?.map(entry => entry.contextId)).toEqual(
    expect.arrayContaining([main.contextId, other.contextId])
  );
  const old = locals?.find(entry => entry.contextId === main.contextId);
  expect(old).toBeDefined();
  expect(await new LocalNoteStorage(old!.database).read('note.md')).toMatchObject({
    status: 'found',
    document: { source: 'old context raw' }
  });
});

it('keeps last known local data readable without marking an unavailable connection verified', async () => {
  catalog();
  let module = await import('../services/storageSession');
  await module.initializeStorageSession(true);
  await createContextDatabase(main.contextId).saveMarkdownDocument('note', 'offline raw');
  vi.resetModules();
  module = await import('../services/storageSession');
  http.on('GET', '/api/storages', () => new Response(null, { status: 503 }));
  const session = await module.initializeStorageSession(true);
  expect(session?.verified).toBe(false);
  expect(await new LocalNoteStorage(session.database).read('note.md')).toMatchObject({
    status: 'found',
    document: { source: 'offline raw' }
  });
});

it('does not treat an unavailable active as permission to use an available reserve', async () => {
  http.on('GET', '/api/storages', () =>
    Response.json({
      activeStorageId: 'main',
      storages: [{ id: 'main', label: 'Main', provider: 'yandex', status: 'unavailable' }, other]
    })
  );
  const session = await (await import('../services/storageSession')).initializeStorageSession(true);
  expect(session?.verified).toBe(false);
  expect(session?.descriptor?.id).not.toBe('other');
});

it('opens cached data as guest without contacting protected storage endpoints', async () => {
  catalog();
  let module = await import('../services/storageSession');
  await module.initializeStorageSession(true);
  vi.resetModules();
  module = await import('../services/storageSession');
  http.fetch.mockClear();
  const guest = await module.initializeStorageSession(false);
  expect(guest?.verified).toBe(false);
  expect(guest?.descriptor?.contextId).toBe(main.contextId);
  expect(http.fetch).not.toHaveBeenCalled();
});

it('coalesces initialization and pins an already verified session for this app lifetime', async () => {
  catalog();
  const module = await import('../services/storageSession');
  const [one, two] = await Promise.all([
    module.initializeStorageSession(true),
    module.initializeStorageSession(true)
  ]);
  for (const session of [one, two]) {
    expect(session).toMatchObject({
      verified: true,
      descriptor: { contextId: main.contextId }
    });
  }
  catalog(other);
  expect((await module.initializeStorageSession(true))?.descriptor?.contextId).toBe(main.contextId);
  expect(http.fetch).toHaveBeenCalledTimes(1);
});

it.each([
  { ...main, contextId: 'forged' },
  { ...main, capabilities: { revisions: 'yes', conditionalCreate: true } },
  { ...main, id: 'missing-active' }
])('does not verify a malformed public catalog %j', async invalid => {
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: 'main', storages: [invalid] })
  );
  expect(
    (await (await import('../services/storageSession')).initializeStorageSession(true))?.verified
  ).toBe(false);
});

it('initializes the scoped runtime before an unassigned queue can be delivered', async () => {
  const { installWebLocks } = await import('./helpers/webLocks');
  installWebLocks();
  const { v1, v1Card } = await import('./helpers/markdownReadFixtures');
  const dbModule = await import('../services/dbService');
  const unassigned = dbModule.dbService;
  const { saves } = await unassigned.getSyncRepositories();
  await saves.save({
    id: 'unassigned-save',
    path: 'note.md',
    document: { version: 1, source: v1, card: v1Card },
    base: { kind: 'missing' },
    createOnly: true,
    createdAt: 0
  });
  catalog();
  http.on('GET', '/api/auth/status', () => Response.json({ authenticated: true }));
  http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [] } }));
  http.on('POST', '/api/cloud/upload', () => new Response('OK'));
  await (await import('../services/appLifecycle')).initializeApplication();
  await (await import('../services/cardSyncRuntime')).retryCardSync();
  expect(http.fetch.mock.calls.filter(([url]) => String(url) === '/api/cloud/upload')).toHaveLength(
    0
  );
  expect((await saves.readCurrent('note.md')).operation?.state.status).toBe('pending');
  expect(await new LocalNoteStorage(dbModule.dbService).list()).toEqual({
    status: 'success',
    entries: []
  });
});

it('binds async CardSync callbacks to the database captured before authentication changes context', async () => {
  catalog();
  await (await import('../services/storageSession')).initializeStorageSession(true);
  await createContextDatabase(main.contextId).saveMarkdownDocument('note', 'exact old raw');
  vi.resetModules();
  const sessionModule = await import('../services/storageSession');
  const guest = await sessionModule.initializeStorageSession(false);
  const databaseModule = await import('../services/dbService');
  const original = databaseModule.dbService.getSyncRepositories.bind(databaseModule.dbService);
  const gate = Promise.withResolvers<void>();
  vi.spyOn(databaseModule.dbService, 'getSyncRepositories').mockImplementation(async () => {
    await gate.promise;
    return original();
  });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const pending = (await import('../services/cardSyncRuntime')).getCardSync();
  catalog(other);
  await sessionModule.initializeStorageSession(true);
  gate.resolve();
  const old = await pending;
  expect(guest?.descriptor?.contextId).toBe(main.contextId);
  expect(await old.load('note.md')).toMatchObject({ source: 'exact old raw' });
  expect(await new LocalNoteStorage(databaseModule.dbService).list()).toEqual({
    status: 'success',
    entries: []
  });
});

it('does not bind a new context when its discoverability cannot be persisted', async () => {
  catalog();
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    if (this.name === 'contexts') {
      this.transaction.abort();
      throw new DOMException('full', 'QuotaExceededError');
    }
    return put.apply(this, args);
  });
  const dbModule = await import('../services/dbService');
  const previous = dbModule.dbService;
  await expect(
    (await import('../services/storageSession')).initializeStorageSession(true)
  ).rejects.toThrow('Failed to remember storage contexts');
  expect(dbModule.dbService).toBe(previous);
});

it('keeps scoped pending delivery blocked after catalog failure even with an authenticated session', async () => {
  catalog();
  await (await import('../services/storageSession')).initializeStorageSession(true);
  const { v1, v1Card } = await import('./helpers/markdownReadFixtures');
  const scoped = createContextDatabase(main.contextId);
  const { saves } = await scoped.getSyncRepositories();
  await saves.save({
    id: 'scoped-save',
    path: 'pending.md',
    document: { version: 1, source: v1, card: v1Card },
    base: { kind: 'missing' },
    createOnly: true,
    createdAt: 0
  });
  const before = await saves.readCurrent('pending.md');
  vi.resetModules();
  const { installWebLocks } = await import('./helpers/webLocks');
  installWebLocks();
  http.on('GET', '/api/auth/status', () => Response.json({ authenticated: true }));
  http.on('GET', '/api/storages', () => new Response(null, { status: 503 }));
  http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [] } }));
  http.on('POST', '/api/cloud/upload', () => new Response('OK'));
  await (await import('../services/appLifecycle')).initializeApplication();
  const currentDatabase = (await import('../services/dbService')).dbService;
  expect(await new LocalNoteStorage(currentDatabase).read('pending.md')).toMatchObject({
    status: 'found',
    document: { source: v1 }
  });
  http.fetch.mockClear();
  await (await import('../services/cardSyncRuntime')).retryCardSync();
  expect(http.fetch).not.toHaveBeenCalled();
  expect(await saves.readCurrent('pending.md')).toEqual(before);
});

it('downgrades the same verified app instance on logout', async () => {
  catalog();
  const module = await import('../services/storageSession');
  const verified = await module.initializeStorageSession(true);
  const guest = await module.initializeStorageSession(false);
  expect(guest?.verified).toBe(false);
  expect(guest?.database).toBe(verified?.database);
  expect(module.getStorageSession()?.verified).toBe(false);
});

it('does not publish an in-flight authenticated catalog after logout', async () => {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  http.on('GET', '/api/storages', () => {
    started.resolve();
    return reply.promise;
  });
  const module = await import('../services/storageSession');
  const loading = module.initializeStorageSession(true);
  try {
    expect(
      await Promise.race([started.promise.then(() => 'request'), loading.then(() => 'finished')])
    ).toBe('request');
    const guest = await module.initializeStorageSession(false);
    reply.resolve(Response.json({ activeStorageId: 'main', storages: [main] }));
    await loading;
    expect(module.getStorageSession()?.verified).toBe(false);
    expect(module.getStorageSession()?.database).toBe(guest?.database);
  } finally {
    reply.resolve(Response.json({ activeStorageId: 'main', storages: [main] }));
    await loading;
  }
});

it('preserves contexts registered concurrently by two independent app instances', async () => {
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const replies = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
  let calls = 0;
  http.on('GET', '/api/storages', () => {
    const index = calls++;
    started[index].resolve();
    return replies[index].promise;
  });
  const firstModule = await import('../services/storageSession');
  const first = firstModule.initializeStorageSession(true);
  let second: Promise<unknown> | undefined;
  try {
    expect(
      await Promise.race([started[0].promise.then(() => 'request'), first.then(() => 'finished')])
    ).toBe('request');
    vi.resetModules();
    const secondModule = await import('../services/storageSession');
    second = secondModule.initializeStorageSession(true);
    expect(
      await Promise.race([started[1].promise.then(() => 'request'), second.then(() => 'finished')])
    ).toBe('request');
    replies[0].resolve(Response.json({ activeStorageId: main.id, storages: [main] }));
    replies[1].resolve(Response.json({ activeStorageId: other.id, storages: [other] }));
    await Promise.all([first, second]);
    vi.resetModules();
    const locals = await (await import('../services/storageSession')).listLocalStorageContexts();
    expect(locals?.map(entry => entry.contextId)).toEqual(
      expect.arrayContaining([main.contextId, other.contextId])
    );
  } finally {
    replies[0].resolve(Response.json({ activeStorageId: main.id, storages: [main] }));
    replies[1].resolve(Response.json({ activeStorageId: other.id, storages: [other] }));
    await Promise.all([first, second]);
  }
});

it('waits for verified binding when login starts a worker without remount', async () => {
  const { installWebLocks } = await import('./helpers/webLocks');
  installWebLocks();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.stubGlobal('BroadcastChannel', undefined);
  const { v1, v1Card } = await import('./helpers/markdownReadFixtures');
  const { saves } = await createContextDatabase(main.contextId).getSyncRepositories();
  await saves.save({
    id: 'login-save',
    path: 'note.md',
    document: { version: 1, source: v1, card: v1Card },
    base: { kind: 'missing' },
    createOnly: true,
    createdAt: 0
  });
  const reply = Promise.withResolvers<Response>();
  http.on('GET', '/api/storages', () => reply.promise);
  http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [] } }));
  http.on('POST', '/api/cloud/upload', () => new Response('OK'));
  const lifecycle = await import('../services/appLifecycle');
  const stop = lifecycle.startApplication();
  try {
    await lifecycle.initializeApplication();
    (await import('../stores/cloudStore')).setAuthenticationStatus(true);
    const { setImmediate } = await import('node:timers');
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(http.fetch.mock.calls.filter(([url]) => String(url) === '/api/storages')).toHaveLength(
      1
    );
    expect(http.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/cloud/'))).toEqual(
      []
    );
    expect((await saves.readCurrent('note.md')).operation?.state.status).toBe('pending');
    reply.resolve(Response.json({ activeStorageId: 'main', storages: [main] }));
    await vi.waitFor(() =>
      expect(
        http.fetch.mock.calls.filter(([url]) => String(url) === '/api/cloud/upload')
      ).toHaveLength(1)
    );
  } finally {
    reply.resolve(Response.json({ activeStorageId: 'main', storages: [main] }));
    stop();
  }
});

it('does not save an opened document into a newly bound storage context', async () => {
  catalog();
  await (await import('../services/storageSession')).initializeStorageSession(true);
  const { v1 } = await import('./helpers/markdownReadFixtures');
  await createContextDatabase(main.contextId).saveMarkdownDocument('note', v1);
  vi.resetModules();
  const sessionModule = await import('../services/storageSession');
  await sessionModule.initializeStorageSession(false);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const cards = await import('../stores/cardStore');
  await cards.loadCard('note');
  expect(get(cards.cardStore)).not.toBeNull();
  catalog(other);
  await sessionModule.initializeStorageSession(true);
  await cards.saveCard('note', { ...get(cards.cardStore)!, title: 'Must stay in old editor' });
  expect(await new LocalNoteStorage(createContextDatabase(other.contextId)).list()).toEqual({
    status: 'success',
    entries: []
  });
  expect(get(cards.cardSaveError)).toMatch(/хранилище.*изменилось|изменилось.*хранилище/i);
});

it('does not publish a late editor load from another storage context', async () => {
  catalog();
  await (await import('../services/storageSession')).initializeStorageSession(true);
  const { v1 } = await import('./helpers/markdownReadFixtures');
  await createContextDatabase(main.contextId).saveMarkdownDocument('note', v1);
  vi.resetModules();
  const sessionModule = await import('../services/storageSession');
  await sessionModule.initializeStorageSession(false);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const db = (await import('../services/dbService')).dbService;
  const original = db.getSyncRepositories.bind(db);
  const gate = Promise.withResolvers<void>();
  vi.spyOn(db, 'getSyncRepositories').mockImplementation(async () => {
    await gate.promise;
    return original();
  });
  const cards = await import('../stores/cardStore');
  const loading = cards.loadCard('note');
  catalog(other);
  await sessionModule.initializeStorageSession(true);
  gate.resolve();
  await loading;
  expect(get(cards.cardStore)).toBeNull();
  expect(get(cards.cardDocument)).toMatchObject({
    status: 'unavailable',
    message: expect.stringMatching(/хранилище.*изменилось|изменилось.*хранилище/i)
  });
});
