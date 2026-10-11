import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { makeCard, NOW, storedCard } from './helpers/fixtures';
import { mockHttp } from './helpers/http';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { onDocumentDownload } from './helpers/documentDownloadHttp';
import { makeReadFile, mockMarkdownReadHttp } from './helpers/markdownReadHttp';
import { v1, v1Card } from './helpers/markdownReadFixtures';

vi.mock('$app/environment', () => ({ browser: true }));

let http: ReturnType<typeof mockHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cards: typeof import('../stores/cardStore');
let cloud: typeof import('../stores/cloudStore');
let cache: typeof import('../services/cacheManager')['cacheManager'];
let service: import('../adapters/browserCloudStorage').BrowserCloudStorage;

function pathUrl(path: string): string { return `/api/cloud/download?path=${encodeURIComponent(path)}`; }

function expectPathDownload(path: string): void {
  const downloads = http.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/cloud/download'));
  expect(downloads).toEqual([[pathUrl(path), { method: 'GET', signal: expect.any(AbortSignal) }]]);
}

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  http = mockHttp();
  db = (await import('../services/dbService')).dbService;
  cards = await import('../stores/cardStore');
  cloud = await import('../stores/cloudStore');
  cache = (await import('../services/cacheManager')).cacheManager;
  service = new (await import('../adapters/browserCloudStorage')).BrowserCloudStorage();

  await cloud.checkIsSessionAuthenticated();
  http.fetch.mockClear();
});
afterEach(() => http.assertHandled());

describe('browser download transport: relative filename, no URL or provider token', () => {
  it.each([
    ['Unicode filename', 'Заметка & планы #1.md', v1],
    ['embedded .md in the filename', 'renamed.md.note.md', '# Source\r\n\r\nText  \r\n'],
    ['UTF-8 BOM', 'bom.md', '\uFEFF# Заметка 🗂\r\n']
  ])('downloads %s through path and preserves the exact source without a browser token', async (_label, path, source) => {

    // Let the old ?url=<filename> request finish too. Assert the actual request,
    // without manufacturing RED through an unregistered mock or a failed fetch.
    onDocumentDownload(http, { name: path, file: path }, () => new Response(source));

    const result = await service.readListed(path);

    expectPathDownload(path);
    expect(result).toEqual({ status: 'found', document: { path, source, revision: null } });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a session refusal on the path request as an error without returning its JSON as note text', async () => {
    const path = 'private.md';
    onDocumentDownload(http, { name: path, file: path }, () => Response.json(
      { success: false, error: 'UNAUTHENTICATED' }, { status: 401 }
    ));

    const result: unknown = await service.readListed(path).catch(error => error);

    expectPathDownload(path);
    expect(result).toEqual({ status: 'unavailable', reason: 'auth' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('active readers: filename comes from the listed note, never its download URL', () => {
  it.each(['editor', 'board', 'background refresh', 'background new file'] as const)
    ('uses the path contract for %s while retaining document/cache behavior', async reader => {
      const file = makeReadFile({ file: 'https://foreign.example.invalid/source?next=disk.yandex.ru' });
      const remote = mockMarkdownReadHttp([{ file, source: v1 }]);
      http = remote.http;
      if (reader === 'background refresh') await db.saveCard(makeCard({ title: 'Earlier cached card' }));

      if (reader === 'editor') await cards.loadCard('test-card');
      else if (reader === 'board') await cloud.loadCardFromCloud(file);
      else await cache.validateCache();

      expectPathDownload(file.name);
      expect(remote.downloads).toEqual([{ filename: file.name, source: v1 }]);
      expect(await db.getMarkdownDocument('test-card')).toMatchObject({
        filename: 'test-card', result: { status: 'success', document: { source: v1, card: v1Card } }
      });
      if (reader === 'editor') expect(get(cards.cardStore)).toEqual(v1Card);
      else expect(await db.getCard('test-card')).toEqual(storedCard(v1Card));
      expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
    });

  it.each(['editor', 'board'] as const)('loads a renamed note in %s even without a provider download URL', async reader => {
    const slug = 'renamed.md.note';
    const file = makeReadFile({ name: `${slug}.md`, path: `disk:/md-cards/${slug}.md`, file: undefined });
    const remote = mockMarkdownReadHttp([{ file, source: v1 }]);
    http = remote.http;

    if (reader === 'editor') await cards.loadCard(slug);
    else await cloud.loadCardFromCloud(file);

    expectPathDownload(file.name);
    expect(remote.downloads).toEqual([{ filename: file.name, source: v1 }]);
    expect(await db.getMarkdownDocument(slug)).toMatchObject({
      filename: slug, result: { status: 'success', document: { source: v1, card: v1Card } }
    });
    if (reader === 'editor') expect(get(cards.cardDocument)).toMatchObject({ filename: slug, saveMode: 'update' });
  });
});
