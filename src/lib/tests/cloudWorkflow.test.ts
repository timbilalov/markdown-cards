import { onDocumentDownload } from './helpers/documentDownloadHttp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { storedCard, makeCard, makeFile, fileList, NOW } from './helpers/fixtures';
import { mockHttp } from './helpers/http';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { futureV1Shape } from './helpers/markdownReadFixtures';

vi.mock('$app/environment', () => ({ browser: true }));

let http: ReturnType<typeof mockHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cloud: typeof import('../stores/cloudStore');
let cards: typeof import('../stores/cardStore');
let service: typeof import('../services/cloudService')['cloudService'];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  http = mockHttp({ authenticated: true });
  db = (await import('../services/dbService')).dbService;
  cloud = await import('../stores/cloudStore');
  cards = await import('../stores/cardStore');
  service = (await import('../services/cloudService')).cloudService;
  setLegacyClientToken(service, 'test-only-token');
  await cloud.checkIsSessionAuthenticated();
  http.on('GET', '/api/cloud/files', () => Response.json(fileList()));
});

afterEach(() => http.assertHandled());

describe('Load workflow with real cache and HTTP boundary', () => {
  it('accounts for successful cache reads as hits and records failed reads in duration statistics', async () => {
    const monitor = (await import('../services/performanceMonitor')).performanceMonitor;
    monitor.reset(); await db.saveCard(makeCard({ meta: { id: 'test-card', created: NOW, modified: NOW } }));
    await cloud.loadCardFromCloud(makeFile());
    expect(monitor.getSummary('cloud')).toMatchObject({ operations: 1, errorRate: 0, hitRate: undefined });
    expect(monitor.getCacheHitRate('card')).toBe(100);
    http.on('GET', '/api/cloud/download?path=missing.md', () => new Response(null, { status: 503 }));
    expect(await cloud.loadCardFromCloud(makeFile({ name: 'missing.md' }))).toBeNull();
    expect(monitor.getSummary('cloud')).toMatchObject({ operations: 2, errorRate: 0.5 });
    expect(monitor.getCacheHitRate('card')).toBe(50);
    expect(monitor.getSummary('cache_card')).toMatchObject({ hitRate: 50 });
  });

  it.each([0, 1])('returns the cache without download when local is equal or %i ms newer', async (delta) => {
    const card = makeCard({ meta: { id: 'test-card', created: NOW, modified: NOW + delta } });
    await db.saveCard(card);
    expect(await cloud.loadCardFromCloud(makeFile())).toEqual(storedCard(card));
    expect(http.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/cloud/download'))).toBe(false);
  });

  it('keeps the cached card when a refresh is denied', async () => {
    const card = makeCard();
    await db.saveCard(card);
    const file = makeFile();
    onDocumentDownload(http, file, () => new Response(null, { status: 401 }));
    expect(await cloud.loadCardFromCloud(file)).toBeNull();
    expect(await db.getCard('test-card')).toEqual(storedCard(card));
  });

  it('retains a Card-only cache without inventing an editable document when listing fails', async () => {
    const cached = makeCard(); await db.saveCard(cached);
    http.on('GET', '/api/cloud/files', () => { throw new TypeError('offline'); });
    await cards.loadCard('test-card');
    expect(get(cards.cardStore)).toBeNull();
    expect(get(cards.cardDocument)).toMatchObject({ status: 'unavailable' });
    expect(get(cards.cardLoadSource)).toBeNull();
    expect(get(cards.cardLoading)).toBe(false);
    expect(await db.getCard(cached.meta.id)).toEqual(storedCard(cached));
  });

  it.each(['missing', '503', '401', 'network'] as const)('keeps an uncached %s document unavailable without inventing an editable Card', async (scenario) => {
    http.on('GET', '/api/cloud/files', () => {
      if (scenario === 'network') throw new TypeError('offline');
      return scenario === 'missing' ? Response.json(fileList()) : new Response(null, { status: Number(scenario) });
    });
    await cards.loadCard('test-card');
    expect(get(cards.cardStore)).toBeNull();
    expect(get(cards.cardDocument)).toMatchObject({ status: 'unavailable' });
    expect(get(cards.cardLoadSource)).toBeNull();
    expect(get(cards.cardLoading)).toBe(false);
    expect(await db.getCard('test-card')).toBeNull();
  });
});

describe('board cache from exact sources and pending snapshots', () => {
  const document = { version: 1 as const, source: v1, card: v1Card };
  it('keeps an unsupported cached filename discoverable without inventing a Card', async () => {
    await db.saveMarkdownDocument('future-note', futureV1Shape);
    const local = await (await import('../stores/dbStore')).loadLocalCards();
    const { reconcileBoardCards } = await import('../domain/board');
    expect(reconcileBoardCards(local, []).cards).toEqual([
      { filename: 'future-note', title: 'future-note', source: 'indexeddb', readOnly: true }
    ]);
    expect(await db.getAllCards()).toEqual([]);
    expect(await db.getMarkdownDocument('future-note')).toMatchObject({ result: { source: futureV1Shape } });
  });


  it('keeps both cached paths discoverable when their documents share an internal ID', async () => {
    await db.saveMarkdownDocument('a', v1);
    const other = v1.replace('Карточка 🗂', 'Other file');
    await db.saveMarkdownDocument('b', other);
    const { saves } = await db.getSyncRepositories();
    const local = v1.replace('Карточка 🗂', 'Pending first file');
    await saves.save({ id: 'pending', path: 'a.md', document: { ...document, source: local,
      card: { ...v1Card, title: 'Pending first file' } }, createOnly: false,
      base: { kind: 'present', revision: null }, baseSource: v1, createdAt: 0 });
    const board = await (await import('../stores/dbStore')).loadLocalCards();
    expect(board.map(card => {
      if ('sourceOnly' in card) throw new Error('Expected supported Card projection');
      return [card.filename ?? card.meta.id, card.title];
    }).sort()).toEqual([
      ['a', 'Pending first file'], ['b', 'Other file']
    ]);
    expect((await saves.readCurrent('a.md')).draft?.source).toBe(local);
  });

  it('discovers another filename with the same ID while preserving the first file\'s pending projection', async () => {
    const { saves } = await db.getSyncRepositories();
    await saves.save({ id: 'pending-first', path: 'a.md', document, createOnly: false,
      base: { kind: 'present', revision: null }, baseSource: v1, createdAt: 0 });
    const before = await db.getAllCards();
    const other = v1.replace('Карточка 🗂', 'Discovered second file');
    await db.refreshMarkdownCache({ filename: 'b', source: other, card: { ...v1Card, title: 'Discovered second file' },
      expected: { source: null, card: before[0] } });
    expect(await db.getAllCards()).toEqual(before);
    expect((await saves.readCurrent('a.md')).draft?.source).toBe(v1);
    const board = await (await import('../stores/dbStore')).loadLocalCards();
    expect(board.map(card => 'sourceOnly' in card ? card.filename : card.filename ?? card.meta.id).sort()).toEqual(['a', 'b']);
    const discovered = board.find(card => card.filename === 'b');
    expect(discovered && !('sourceOnly' in discovered) ? discovered.title : null).toBe('Discovered second file');
  });

  it('uses a freshly read source for board Status even when user Modified is in the future', async () => {
    const source = v1.replace(new Date(v1Card.meta.modified).toISOString(), '2050-01-01T00:00:00.000Z');
    const { parseMarkdownDocument } = await import('../domain/markdown');
    const parsed = parseMarkdownDocument(source); expect(parsed.status).toBe('success');
    if (parsed.status !== 'success') throw new Error('Bad fixture');
    await db.saveCard(parsed.document.card); await db.saveMarkdownDocument(parsed.document.card.meta.id, source);
    const path = `${parsed.document.card.meta.id}.md`;
    http.on('GET', '/api/cloud/files', () => Response.json(fileList([{ name: path, path }])));
    const fresh = source.replace('**Status:** В процессе', '**Status:** Done');
    http.on('GET', `/api/cloud/download?path=${encodeURIComponent(path)}`, () => new Response(fresh));
    const { getCardSync } = await import('../services/cardSyncRuntime');
    expect(await (await getCardSync()).load(path)).toMatchObject({ source: fresh });
    const board = await (await import('../stores/dbStore')).loadLocalCards();
    const freshCard = board.find(card => !('sourceOnly' in card) && card.meta.id === parsed.document.card.meta.id);
    expect(freshCard && !('sourceOnly' in freshCard) ? freshCard.status : null).toBe('Done');
    expect(get(cloud.cloudFiles)).toEqual([]);
  });
});
