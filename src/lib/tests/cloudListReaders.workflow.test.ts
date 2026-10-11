import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { mockHttp } from './helpers/http';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { DAY, makeCard, NOW, storedCard } from './helpers/fixtures';
import { v1, v1Card } from './helpers/markdownReadFixtures';

vi.mock('$app/environment', () => ({ browser: true }));
const apiUrl = '/api/cloud/files';
const filename = 'archive.md.note'; // Storage filename deliberately differs from Card ID.
const file = { name: `${filename}.md`, path: `${filename}.md`, modified: new Date(NOW).toISOString() };
const remoteSource = v1.replace('# Карточка 🗂', '# Remote version');
const localSource = v1.replace('# Карточка 🗂', '# Local saved version');
let http: ReturnType<typeof mockHttp>;
let db: typeof import('../services/dbService')['dbService'];
let service: typeof import('../services/cloudService')['cloudService'];
let cache: typeof import('../services/cacheManager')['cacheManager'];
let cards: typeof import('../stores/cardStore');
let cloud: typeof import('../stores/cloudStore');

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  http = mockHttp({ authenticated: true });
  db = (await import('../services/dbService')).dbService;
  service = (await import('../services/cloudService')).cloudService;
  setLegacyClientToken(service, null);
  cache = (await import('../services/cacheManager')).cacheManager;
  cards = await import('../stores/cardStore');
  cloud = await import('../stores/cloudStore');
  await cloud.checkIsSessionAuthenticated();
  http.fetch.mockClear();
  http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [file] } }));
  http.on('GET', `/api/cloud/download?path=${encodeURIComponent(file.name)}`, () => new Response(remoteSource));
  // Keep an old transport attempt observable without incidental mock failures.
  http.on('GET', 'https://cloud-api.yandex.net/v1/disk/resources?path=md-cards',
    () => Response.json({ _embedded: { items: [] } }));
});
afterEach(() => http.assertHandled());

function expectListRequestOnly() {
  expect(http.fetch.mock.calls).toEqual([[apiUrl, { method: 'GET', signal: expect.any(AbortSignal) }]]);
}

function refuseList(failure: '401' | '503' | 'network' | 'malformed') {
  http.on('GET', apiUrl, () => {
    if (failure === 'network') throw new TypeError('test-only disconnected');
    if (failure === 'malformed') return Response.json({ _embedded: { items: {} } });
    return new Response(null, { status: Number(failure) });
  });
}

describe('editor listing through the server without a browser provider token', () => {
  it.each([false, true])('loads exact remote v1 with a prior cached document=%s', async hasCache => {
    if (hasCache) await db.saveMarkdownDocument(filename, v1);

    await cards.loadCard(filename);

    expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, saveMode: 'update',
      result: { status: 'success', document: { source: remoteSource, card: { ...v1Card, title: 'Remote version' } } } });
    expect(get(cards.cardLoadSource)).toBe('cloud');
    expect(get(cards.isOffline)).toBe(false);
    expect(http.fetch.mock.calls).toEqual([
      [apiUrl, { method: 'GET', signal: expect.any(AbortSignal) }],
      [`/api/cloud/download?path=${encodeURIComponent(file.name)}`, { method: 'GET', signal: expect.any(AbortSignal) }]
    ]);
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: remoteSource } } });
    expect(await db.getMarkdownDocument(v1Card.meta.id)).toBeNull();
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('can read through the session and then reopen a local snapshot without another remote read', async () => {
    await cards.loadCard(filename);
    expect(get(cards.cardLoadSource)).toBe('cloud');
    await historicalStorage.saveLocalMarkdownSnapshot({ filename, source: localSource, saveMode: 'update' });
    http.fetch.mockClear();

    await cards.loadCard(filename);

    expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename,
      result: { document: { source: localSource, card: { ...v1Card, title: 'Local saved version' } } } });
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    expect(http.fetch).not.toHaveBeenCalled();
    expect(await db.getLocalMarkdownSnapshot(filename)).toEqual({ filename, source: localSource, saveMode: 'update' });
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: remoteSource } } });
  });

  it.each(['401', 'network', 'malformed'] as const)('preserves cached source after %s, without declaring remote absence', async failure => {
    await db.saveMarkdownDocument(filename, v1);
    refuseList(failure);

    await cards.loadCard(filename);

    expectListRequestOnly();
    const document = get(cards.cardDocument);
    expect(document).toMatchObject({ status: 'loaded', filename, result: { document: { source: v1 } } });
    expect(document && cards.getCardDocumentMessage(document)).toBeNull();
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    expect(get(cards.cardSaveMessage)).toMatch(/не провер|не подтвержд/i);
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: v1 } } });
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('marks a cached document remote-missing only after a successful server list confirms absence', async () => {
    await db.saveMarkdownDocument(filename, v1);
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [] } }));

    await cards.loadCard(filename);

    expectListRequestOnly();
    expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, readOnlyReason: 'remote-missing',
      result: { document: { source: v1 } } });
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: v1 } } });
  });
});

describe('background readers no longer depend on a browser provider token', () => {
  it('refreshes cached source and Card through server list and download', async () => {
    await db.saveCard(makeCard({ title: 'Old card' }));
    const named = { ...file, name: 'test-card.md', path: 'test-card.md' };
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [named] } }));
    http.on('GET', '/api/cloud/download?path=test-card.md', () => new Response(v1));

    await cache.validateCache();

    expect(await db.getCard('test-card')).toEqual(storedCard(v1Card));
    expect(await db.getMarkdownDocument('test-card')).toMatchObject({ result: { document: { source: v1 } } });
    expect(http.fetch.mock.calls).toEqual([
      [apiUrl, { method: 'GET', signal: expect.any(AbortSignal) }], ['/api/cloud/download?path=test-card.md', { method: 'GET', signal: expect.any(AbortSignal) }]
    ]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it.each(['401', '503', 'network', 'malformed'] as const)('aborts validation after %s without deleting old local data', async failure => {
    await db.saveMarkdownDocument(filename, v1);
    await historicalStorage.saveLocalMarkdownSnapshot({ filename, source: localSource, saveMode: 'update' });
    // Restore an old Card timestamp so an accidental empty list reaches the
    // legacy destructive branch; snapshot/source/outbox are independently kept.
    const old = makeCard({ meta: { ...v1Card.meta, modified: NOW - 40 * DAY } });
    await db.saveCard(old);
    await historicalStorage.queueSyncOperation({ id: 'pending-write', type: 'update', card: old,
      path: `${filename}.md`, timestamp: NOW - 40 * DAY, attempts: 2 });
    const pending = await historicalStorage.getPendingSyncOperations();
    const metadata = { name: 'old.md', path: 'old.md' };
    await historicalStorage.saveCloudFile(metadata);
    refuseList(failure);

    await cache.validateCache();

    expectListRequestOnly();
    expect(await db.getCard('test-card')).toEqual(storedCard(old));
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: v1 } } });
    expect(await db.getLocalMarkdownSnapshot(filename)).toEqual({ filename, source: localSource, saveMode: 'update' });
    expect(await historicalStorage.getPendingSyncOperations()).toEqual(pending);
    expect(await historicalStorage.getAllCloudFiles()).toEqual([metadata]);
  });
});

describe('cloud store publishes only validated server lists', () => {
  it.each(['success', 'failure'] as const)('ignores an older %s response after a newer listing completed in the same session', async outcome => {
    const monitor = (await import('../services/performanceMonitor')).performanceMonitor;
    monitor.reset();
    const old = Promise.withResolvers<Response>(); let calls = 0;
    const newer = { name: 'newer.md', path: 'newer.md' };
    http.on('GET', apiUrl, () => ++calls === 1 ? old.promise : Response.json({ _embedded: { items: [newer] } }));
    const first = cloud.syncFilesFromCloud(); await cloud.syncFilesFromCloud();
    old.resolve(outcome === 'success' ? Response.json({ _embedded: { items: [file] } }) : new Response(null, { status: 503 }));
    await first;
    expect(get(cloud.cloudFiles)).toEqual([newer]);
    expect(get(cloud.syncStatus)).toMatchObject({ isSyncing: false, error: null });
    expect(monitor.getSummary('cloud')).toMatchObject({ operations: 2, errorRate: outcome === 'success' ? 0 : 0.5 });
  });

  it.each([
    { label: 'non-array collection', items: {} },
    { label: 'duplicate filename', items: [file, file] },
    { label: 'provider path', items: [{ ...file, path: 'disk:/private/other.md' }] },
    { label: 'invalid date', items: [{ ...file, modified: null }] }
  ])('retains prior list and lastSync after $label, then recovers on a valid response', async ({ items }) => {
    const previous = { name: 'previous.md', path: 'previous.md' };
    cloud.cloudFiles.set([previous]);
    cloud.syncStatus.set({ isSyncing: false, lastSync: NOW - DAY, error: null });
    await historicalStorage.saveCloudFile(previous);
    const write = vi.spyOn(historicalStorage, 'saveCloudFile');
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items } }));

    await cloud.syncFilesFromCloud();

    expect(get(cloud.cloudFiles)).toEqual([previous]);
    expect(get(cloud.syncStatus)).toMatchObject({ isSyncing: false, lastSync: NOW - DAY, error: expect.any(String) });
    expectListRequestOnly();
    expect(write).not.toHaveBeenCalled();
    expect(await historicalStorage.getAllCloudFiles()).toEqual([previous]);

    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [file] } }));
    await cloud.syncFilesFromCloud();
    expect(get(cloud.cloudFiles)).toEqual([file]);
    expect(get(cloud.syncStatus)).toMatchObject({ isSyncing: false, lastSync: NOW, error: null });
    expect(await historicalStorage.getCloudFile(file.path)).toBeNull();
    expect(http.fetch).toHaveBeenCalledTimes(2);
    cloud.setAuthenticationStatus(false);
    await cloud.syncFilesFromCloud();
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
});
