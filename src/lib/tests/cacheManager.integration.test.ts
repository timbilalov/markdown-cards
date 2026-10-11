import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers';
import { storedCard, makeCard, fileList, NOW, DAY } from './helpers/fixtures';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { mockHttp } from './helpers/http';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { onCloudFileList } from './helpers/cloudListHttp';

let http: ReturnType<typeof mockHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cache: typeof import('../services/cacheManager')['cacheManager'];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  http = mockHttp();
  db = (await import('../services/dbService')).dbService;
  cache = (await import('../services/cacheManager')).cacheManager;
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
});

afterEach(() => http.assertHandled());

describe('Cache cleanup characterization', () => {
  it('records a failed validation when the listed source could not be read', async () => {
    const monitor = (await import('../services/performanceMonitor')).performanceMonitor;
    monitor.reset();
    http.on('GET', '/api/cloud/files', () => Response.json(fileList([{ name: 'a.md', path: 'a.md' }])));
    http.on('GET', '/api/cloud/download?path=a.md', () => new Response(null, { status: 503 }));
    await cache.validateCache();
    expect(monitor.getSummary('cache_validation')).toMatchObject({ operations: 1, errorRate: 1 });
    expect(await db.getMarkdownDocument('a')).toBeNull();
  });

  it('does not treat a failed cloud listing as an empty folder', async () => {
    const card = makeCard({ meta: { id: 'test-card', created: NOW - 40 * DAY, modified: NOW - 40 * DAY } });
    await db.saveCard(card);
    onCloudFileList(http, () => new Response(null, { status: 401 }));
    await cache.validateCache();
    expect(await db.getCard('test-card')).toEqual(storedCard(card));
  });

});

it.each(['listing', 'download'] as const)('cancels cache %s so a new session can validate before the hourly retry', async mode => {
  await db.saveCard(v1Card);
  const cloud = await import('../stores/cloudStore'); cloud.setAuthenticationStatus(true);
  const started = Promise.withResolvers<void>(); const oldResponse = Promise.withResolvers<Response>();
  const listing = fileList([{ name: 'a.md', path: 'a.md' }]);
  let requests = 0;
  const updated = v1.replace('Карточка 🗂', 'New session cache');
  const delayedUrl = mode === 'listing' ? '/api/cloud/files' : '/api/cloud/download?path=a.md';
  http.on('GET', '/api/cloud/files', () => Response.json(listing));
  http.on('GET', '/api/cloud/download?path=a.md', () => new Response(updated));
  http.on('GET', delayedUrl, init => {
    if (++requests > 1) return mode === 'listing' ? Response.json(listing) : new Response(updated);
    started.resolve();
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      oldResponse.promise.then(resolve, reject);
    });
  });
  const controller = new AbortController(); const first = cache.validateCache(controller.signal);
  await started.promise; cloud.setAuthenticationStatus(false); controller.abort(); cloud.setAuthenticationStatus(true);
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  await cache.validateCache(new AbortController().signal);
  oldResponse.resolve(Response.json(listing)); await first;
  expect(requests).toBe(2);
  expect(await db.getMarkdownDocument('a')).toMatchObject({ result: { document: { source: updated } } });
});
