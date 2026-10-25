import { initializeTestStorage } from './helpers/browserStorageContext';
import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { setImmediate } from 'node:timers';
import { mockHttp } from './helpers/http';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { fileList, makeFile } from './helpers/fixtures';
import { installWebLocks } from './helpers/webLocks';

vi.mock('$app/environment', () => ({ browser: true }));

let http: ReturnType<typeof mockHttp>;
let cloud: typeof import('../stores/cloudStore');
let lifecycle: typeof import('../services/appLifecycle');
let db: typeof import('../services/dbService')['dbService'];
let stop: (() => void) | undefined;
let authenticated: boolean;
let authUnavailable: boolean;
const path = 'pending-note.md';

beforeEach(async () => {
  installWebLocks();
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  authenticated = false; authUnavailable = false;
  http = mockHttp();
  http.on('GET', '/api/auth/status', () => {
    if (authUnavailable) throw new TypeError('Session endpoint unavailable');
    return Response.json({ authenticated });
  });
  http.on('POST', '/api/auth/logout', () => {
    authenticated = false;
    return Response.json({ success: true });
  });
  // Register a real refusal, not a missing mock. RED must expose the unwanted
  // protected request even when the application catches the server's 401.
  http.on('GET', '/api/cloud/files', () => authenticated
    ? Response.json({ _embedded: { items: [] } })
    : Response.json({ error: 'Not authenticated' }, { status: 401 }));
  await initializeTestStorage(http);
  db = (await import('../services/dbService')).dbService;
  cloud = await import('../stores/cloudStore');
  lifecycle = await import('../services/appLifecycle');
});

afterEach(async () => {
  stop?.(); stop = undefined;
  await drainIndexedDb();
  http.assertHandled();
});

// fake-indexeddb dispatches request/commit callbacks through the real immediate
// queue. Drain it after clock advancement so assertions include completed work.
async function drainIndexedDb() {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
async function start() {
  stop = lifecycle.startApplication();
  await lifecycle.initializeApplication();
  await drainIndexedDb();
}
async function advance(milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await drainIndexedDb();
}
function cloudRequests() {
  return http.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/cloud/'));
}

describe('background cloud work follows the authenticated session', () => {
  it('does not continue a worker preflight after logout or mark an unstarted upload uncertain', async () => {
    installWebLocks();
    const { saves } = await db.getSyncRepositories();
    await saves.save({ id: 'pending-worker', path, document: { version: 1, source: v1, card: v1Card },
      createOnly: false, base: { kind: 'present', revision: null }, baseSource: v1, createdAt: 0 });
    const listed = Promise.withResolvers<Response>();
    http.on('GET', '/api/cloud/files', () => listed.promise);
    http.on('GET', `/api/cloud/download?path=${path}`, () => new Response(v1));
    http.on('POST', '/api/cloud/upload', () => Response.json({ success: true }));
    authenticated = true;
    await start();
    expect(cloudRequests()).toHaveLength(1);
    await cloud.logout();
    http.fetch.mockClear();
    listed.resolve(Response.json(fileList([makeFile({ name: path })])));
    await drainIndexedDb();
    expect(cloudRequests()).toEqual([]);
    expect((await saves.readCurrent(path)).operation?.state.status).toBe('pending');
  });

  it('does not publish a cloud list received after logout', async () => {
    authenticated = true;
    await cloud.checkIsSessionAuthenticated();
    const listed = Promise.withResolvers<Response>();
    http.on('GET', '/api/cloud/files', () => listed.promise);
    const syncing = cloud.syncFilesFromCloud();
    await cloud.logout();
    listed.resolve(Response.json(fileList([makeFile()])));
    await syncing;
    expect(get(cloud.cloudFiles)).toEqual([]);
    expect(get(cloud.syncStatus)).toMatchObject({ isSyncing: false, lastSync: null });
  });

  it.each(['guest', 'session unavailable'] as const)('does not list files after the startup delay for %s', async mode => {
    authUnavailable = mode === 'session unavailable';
    await start();
    expect(get(cloud.isAuthenticated)).toBe(false);

    await advance(5100);

    expect(cloudRequests()).toEqual([]);
    expect(await historicalStorage.getAllCloudFiles()).toEqual([]);
  });

  it('retains a pending Save without attempting delivery before login, including an online event', async () => {
    const { saves } = await db.getSyncRepositories();
    await saves.save({ id: 'saved-before-logout', path, document: { version: 1, source: v1, card: v1Card },
      createOnly: true, base: { kind: 'missing' }, createdAt: Date.now() - 1000 });
    const before = await saves.readCurrent(path);
    await start();
    window.dispatchEvent(new Event('online'));
    await advance(1500);

    expect(cloudRequests()).toEqual([]);
    expect(await saves.readCurrent(path)).toEqual(before);
  });

  it('does not start an independent cache refresh after a later login without remount', async () => {
    authenticated = true;
    await start();
    expect(get(cloud.isAuthenticated)).toBe(true);
    await cloud.logout();
    expect(get(cloud.isAuthenticated)).toBe(false);
    http.fetch.mockClear();

    await advance(5100);

    expect(cloudRequests()).toEqual([]);
    authenticated = true;
    expect(await cloud.checkIsSessionAuthenticated()).toBe(true);
    await drainIndexedDb(); // Login verifies/binds the destination before timers start.
    await advance(5100);
    expect(cloudRequests()).toEqual([]);
    stop?.(); stop = undefined;
    http.fetch.mockClear();
    await cloud.logout();
    authenticated = true;
    await cloud.checkIsSessionAuthenticated();
    await advance(5100);
    expect(cloudRequests()).toEqual([]);
  });

  it('does not duplicate a board refresh at startup or on another visit within ten minutes', async () => {
    authenticated = true;
    await start();
    const { app } = await import('../stores/appFacade');
    await app.loadBoard(() => {}, new AbortController().signal);
    expect(cloudRequests()).toHaveLength(1);
    await advance(5100);
    await app.loadBoard(() => {}, new AbortController().signal);
    expect(cloudRequests()).toHaveLength(1);
    await cloud.logout();
    http.fetch.mockClear();
    await advance(5100);
    expect(cloudRequests()).toEqual([]);
  });
});
