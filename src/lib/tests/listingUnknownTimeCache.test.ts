import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCard, NOW, storedCard } from './helpers/fixtures';
import { mockHttp } from './helpers/http';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { onCloudFileList } from './helpers/cloudListHttp';
import { v1, v1Card } from './helpers/markdownReadFixtures';

let http: ReturnType<typeof mockHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cache: typeof import('../services/cacheManager')['cacheManager'];

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  http = mockHttp();
  db = (await import('../services/dbService')).dbService;
  cache = (await import('../services/cacheManager')).cacheManager;
  // Legacy client configuration must not change the current session transport.
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'legacy-cache-test-token');
  onCloudFileList(http, () => Response.json({ _embedded: { items: [
    { name: 'test-card.md', path: 'test-card.md' }
  ] } }));
});
afterEach(() => http.assertHandled());

describe('background refresh: an absent modification hint does not prove the cache is fresh', () => {
  it.each(['success', 'refused'] as const)('attempts a content read when the result is %s', async outcome => {
    const local = makeCard({ title: 'Сохранённая карточка' });
    await db.saveCard(local);
    http.on('GET', '/api/cloud/download?path=test-card.md', () => outcome === 'success'
      ? new Response(v1) : new Response(null, { status: 401 }));

    await cache.validateCache();

    const downloads = http.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/cloud/download'));
    expect(downloads).toEqual([['/api/cloud/download?path=test-card.md', { method: 'GET', signal: expect.any(AbortSignal) }]]);
    expect(await db.getCard('test-card')).toEqual(storedCard(outcome === 'success' ? v1Card : local));
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
    if (outcome === 'success') {
      expect(await db.getMarkdownDocument('test-card')).toMatchObject({
        result: { status: 'success', document: { source: v1 } }
      });
    } else {
      expect(await db.getMarkdownDocument('test-card')).toBeNull();
    }
  });
});
