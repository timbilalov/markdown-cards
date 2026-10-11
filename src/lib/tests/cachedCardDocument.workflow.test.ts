import { historicalStorage } from './helpers/historicalStorage';
import { saveRepositoryPrototype } from './helpers/saveRepository';
import { onDocumentDownload } from './helpers/documentDownloadHttp';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Card, MarkdownParseResult } from '../domain/types';
import type { LocalMarkdownSnapshot } from '../services/dbService';
import { v1, v1Card, futureV1Shape, unknownMetadata } from './helpers/markdownReadFixtures';
import { makeReadFile, mockMarkdownReadHttp } from './helpers/markdownReadHttp';
import { fileList, makeCard, NOW } from './helpers/fixtures';
import legacy from './fixtures/migration-legacy.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));
const filename = 'archive.md.Заметка'; // Neither Card ID nor filename with its final extension.
const file = makeReadFile({ name: `${filename}.md`, path: `disk:/md-cards/${filename}.md` });
const localSource = v1.replace('# Карточка 🗂', '# Local saved version');
const localCard: Card = { ...v1Card, title: 'Local saved version' };
const remoteSource = v1.replace('# Карточка 🗂', '# Remote changed version');
let remote: ReturnType<typeof mockMarkdownReadHttp>;
let db: typeof import('../services/dbService')['dbService'];
let DBService: typeof import('../services/dbService')['DBService'];
let cards: typeof import('../stores/cardStore');
let service: typeof import('../services/cloudService')['cloudService'];

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  remote = mockMarkdownReadHttp([{ file, source: remoteSource }]);
  await importRuntime();
});

afterEach(() => remote.http.assertHandled());

async function importRuntime() {
  ({ dbService: db, DBService } = await import('../services/dbService'));
  cards = await import('../stores/cardStore');
  service = (await import('../services/cloudService')).cloudService;
  setLegacyClientToken(service, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  remote.http.fetch.mockClear();
}

function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
}

function expectRecovered(source: string, card: Card, saveMode: 'create' | 'update' = 'update') {
  expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, saveMode,
    result: { status: 'success', document: { version: 1, source, card } },
    migrationError: null });
  expect(get(cards.cardStore)).toMatchObject(card);
  expect(get(cards.cardLoadSource)).toBe('indexeddb');
  expect(get(cards.cardLoading)).toBe(false);
}

const refused: { label: string; source: string; result: MarkdownParseResult }[] = [
  { label: 'legacy with CRLF', source: legacy.replaceAll('\n', '\r\n'),
    result: { status: 'unsupported', source: legacy.replaceAll('\n', '\r\n'), reason: 'missing-version' } },
  { label: 'future version', source: futureV1Shape,
    result: { status: 'unsupported', source: futureV1Shape, reason: 'unknown-version' } },
  { label: 'unknown metadata', source: unknownMetadata,
    result: { status: 'unsupported', source: unknownMetadata, reason: 'unsupported-content' } },
  { label: 'bad timestamp', source: v1.replace('2026-09-25T12:34:56.789Z', 'not-a-date'),
    result: { status: 'invalid', source: v1.replace('2026-09-25T12:34:56.789Z', 'not-a-date'), reason: 'invalid-timestamp' } },
  { label: 'empty source', source: '', result: { status: 'unsupported', source: '', reason: 'missing-version' } }
];

describe('editor recovery: cached source when the remote is unavailable', () => {
  it('restores exact CRLF v1 and complete fields by filename without using or changing an unrelated Card', async () => {
    const source = (v1 + '\n\n').replaceAll('\n', '\r\n');
    const unrelated = makeCard({ title: 'Do not infer source from this Card', meta: { ...v1Card.meta, id: filename } });
    await db.saveCard(unrelated);
    await db.saveMarkdownDocument(filename, source);
    goOffline();
    const before = await db.getAllCards();

    await cards.loadCard(filename);

    expectRecovered(source, v1Card);
    expect(get(cards.isOffline)).toBe(true);
    expect(get(cards.cardSaveMessage)).toMatch(/локальн|кеш|кэш/i);
    expect(get(cards.cardSaveMessage)).toMatch(/не провер|не подтвержд/i);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(await new DBService().getAllCards()).toEqual(before);
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
    cards.cardStore.update(card => card && { ...card, title: 'Unsaved in memory' });
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source, card: v1Card } } });
  });

  // Cycle eleven replaces the no-token/no-HTTP expectation with server reads
  // independent of a browser provider token (cloudListReaders.workflow.test.ts).

  it.each(['listing network', 'listing 503', 'listing 401', 'download network'] as const)(
    'recovers the cache after %s instead of treating a transient failure as remote absence', async failure => {
      await db.saveMarkdownDocument(filename, v1);
      const downloadStarted = Promise.withResolvers<void>();
      if (failure === 'download network') {
        // Exercise real retries without spending seven seconds on backoff.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        onDocumentDownload(remote.http, file, () => {
          downloadStarted.resolve();
          throw new TypeError('Download disconnected');
        });
      } else {
        remote.http.on('GET', '/api/cloud/files', () => {
          if (failure === 'listing network') throw new TypeError('Listing disconnected');
          return new Response(null, { status: failure === 'listing 401' ? 401 : 503 });
        });
      }

      const loading = cards.loadCard(filename);
      if (failure === 'download network') {
        const phase = await Promise.race([
          downloadStarted.promise.then(() => 'downloading'), loading.then(() => 'finished')
        ]);
        expect(phase).toBe('downloading');
        await vi.runAllTimersAsync();
      }
      await loading;

      expectRecovered(v1, v1Card);
      const document = get(cards.cardDocument);
      expect(document && cards.getCardDocumentMessage(document)).toBeNull();
      expect(get(cards.cardSaveMessage)).toMatch(/не провер|не подтвержд/i);
      expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: v1 } } });
      expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    }
  );

  it.each(refused)('retains cached $label with its compatibility result and blocks direct Save', async ({ source, result }) => {
    await db.saveMarkdownDocument(filename, source);
    goOffline();
    const write = vi.spyOn(await saveRepositoryPrototype(), 'save');

    await cards.loadCard(filename);

    expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, result });
    const document = get(cards.cardDocument);
    expect(document && cards.getCardDocumentSource(document)).toBe(source);
    expect(get(cards.cardStore)).toBeNull();
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    await cards.saveCard(filename, makeCard());
    expect(get(cards.cardSaveError)).toEqual(expect.any(String));
    expect(write).not.toHaveBeenCalled();
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(await new DBService().getMarkdownDocument(filename)).toEqual({ filename, result });
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
  });

  it('shows cached source read-only after a successful listing confirms that the remote file is absent', async () => {
    await db.saveMarkdownDocument(filename, v1);
    remote.http.on('GET', '/api/cloud/files', () => Response.json(fileList([])));
    const write = vi.spyOn(await saveRepositoryPrototype(), 'save');

    await cards.loadCard(filename);

    const document = get(cards.cardDocument);
    expect(document && cards.getCardDocumentSource(document)).toBe(v1);
    expect(document && cards.getCardDocumentMessage(document)).toMatch(/не найден|отсутствует/i);
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    await cards.saveCard(filename, v1Card);
    expect(get(cards.cardSaveError)).toMatch(/не найден|отсутствует/i);
    expect(write).not.toHaveBeenCalled();
    expect(remote.downloads).toEqual([]);
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: v1 } } });
  });
});

describe('editor recovery: local Save has priority over cached or downloadable source', () => {
  it.each([
    ['create', false], ['create', true], ['update', false], ['update', true]
  ] as const)('restores %s after reimport (online=%s), without replacing or sending the saved snapshot', async (saveMode, online) => {
    const snapshot: LocalMarkdownSnapshot = { filename, source: localSource, saveMode };
    await historicalStorage.saveLocalMarkdownSnapshot(snapshot);
    await db.saveMarkdownDocument(filename, remoteSource);
    const before = await db.getAllCards();
    vi.resetModules();
    await importRuntime();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
    const acknowledge = vi.spyOn(await saveRepositoryPrototype(), 'finishDelivery');
    const write = vi.spyOn(await saveRepositoryPrototype(), 'save');

    await cards.loadCard(filename);

    expectRecovered(localSource, localCard, saveMode);
    expect(get(cards.isOffline)).toBe(!online);
    expect(get(cards.cardSaveMessage)).toMatch(/локальн/i);
    expect(get(cards.cardSaveMessage)).toMatch(/не подтвержд/i);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await new DBService().getLocalMarkdownSnapshot(filename)).toEqual(snapshot);
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: remoteSource } } });
    expect(await db.getAllCards()).toEqual(before);
  });

  it('can restore a saved snapshot even if the independent downloaded-source cache cannot be read', async () => {
    await historicalStorage.saveLocalMarkdownSnapshot({ filename, source: localSource, saveMode: 'update' });
    const readSource = vi.spyOn(db, 'getMarkdownDocument').mockRejectedValue(new Error('source read aborted'));
    goOffline();

    await cards.loadCard(filename);

    expectRecovered(localSource, localCard);
    expect(readSource).not.toHaveBeenCalled();
    expect(await db.getLocalMarkdownSnapshot(filename)).toMatchObject({ source: localSource });
  });

  it('refuses to select the remote when reading pending state fails, preserving the recoverable snapshot', async () => {
    const snapshot: LocalMarkdownSnapshot = { filename, source: localSource, saveMode: 'update' };
    await historicalStorage.saveLocalMarkdownSnapshot(snapshot);
    vi.spyOn(await saveRepositoryPrototype(), 'readCurrent').mockRejectedValue(new Error('snapshot read aborted'));

    await cards.loadCard(filename);

    expect(get(cards.cardDocument)).toMatchObject({ status: 'unavailable', filename });
    const document = get(cards.cardDocument);
    expect(document && cards.getCardDocumentMessage(document)).toContain('snapshot read aborted');
    expect(get(cards.cardLoading)).toBe(false);
    await cards.saveCard(filename, v1Card);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(await new DBService().getLocalMarkdownSnapshot(filename)).toEqual(snapshot);
  });

  it('reports failure to read the downloaded cache instead of treating it as a missing record', async () => {
    await db.saveMarkdownDocument(filename, v1);
    vi.spyOn(db, 'getMarkdownDocument').mockRejectedValue(new Error('cached source read aborted'));
    goOffline();

    await cards.loadCard(filename);

    const document = get(cards.cardDocument);
    expect(document && cards.getCardDocumentMessage(document)).toContain('cached source read aborted');
    expect(get(cards.cardDocument)).toMatchObject({ status: 'unavailable', filename });
    expect(get(cards.cardLoading)).toBe(false);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(await new DBService().getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: v1 } } });
  });
});

// A stored record may come from a different app version or damaged local data.
// Bypass write-time validation only to exercise the editor's read boundary.
async function seedUnvalidatedSnapshot(source: string) {
  await db.init();
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = connection.transaction('localMarkdownSnapshots', 'readwrite');
      transaction.objectStore('localMarkdownSnapshots').put({ filename, source, saveMode: 'update' });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    connection.close();
  }
}

describe('editor recovery: revalidate persisted source before editing', () => {
  it.each(refused.filter(entry => entry.label !== 'empty source' && entry.label !== 'unknown metadata'))(
    'retains a stored snapshot with $label, without hiding it behind a valid remote source', async ({ source, result }) => {
      await seedUnvalidatedSnapshot(source);
      await db.saveMarkdownDocument(filename, v1);

      await cards.loadCard(filename);

      expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, result });
      expect(get(cards.cardStore)).toBeNull();
      await cards.saveCard(filename, v1Card);
      expect(get(cards.cardSaveError)).toEqual(expect.any(String));
      expect(remote.http.fetch).not.toHaveBeenCalled();
      expect(await new DBService().getLocalMarkdownSnapshot(filename)).toEqual({ filename, source, saveMode: 'update' });
      expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: v1 } } });
    }
  );
});

describe('editor recovery: late IndexedDB reads cannot reset a newer editor', () => {
  it.each([
    ['snapshot', false], ['snapshot', true], ['source', false], ['source', true]
  ] as const)('ignores a stale %s read (reject=%s) after opening a new note', async (kind, shouldReject) => {
    await db.saveMarkdownDocument(filename, v1);
    if (kind === 'snapshot') await historicalStorage.saveLocalMarkdownSnapshot({ filename, source: localSource, saveMode: 'update' });
    goOffline();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (kind === 'snapshot') {
      const read = (await saveRepositoryPrototype()).readCurrent;
      vi.spyOn(await saveRepositoryPrototype(), 'readCurrent').mockImplementation(async function (this: Awaited<ReturnType<typeof saveRepositoryPrototype>>, name) {
        const saved = await read.call(this, name);
        started.resolve();
        await release.promise;
        if (shouldReject) throw new Error('late snapshot read failure');
        return saved;
      });
    } else {
      const read = db.getMarkdownDocument.bind(db);
      vi.spyOn(db, 'getMarkdownDocument').mockImplementation(async name => {
        const cached = await read(name);
        started.resolve();
        await release.promise;
        if (shouldReject) throw new Error('late cached source read failure');
        return cached;
      });
    }
    const loading = cards.loadCard(filename);
    try {
      const phase = await Promise.race([started.promise.then(() => 'reading'), loading.then(() => 'finished')]);
      expect(phase).toBe('reading');
      expect(get(cards.cardLoading)).toBe(true);
      cards.openNewCard();
      const newDocument = get(cards.cardDocument);
      const newDraft = structuredClone(get(cards.cardStore));
      release.resolve();
      await loading;
      expect(get(cards.cardDocument)).toEqual(newDocument);
      expect(get(cards.cardStore)).toEqual(newDraft);
      expect(get(cards.cardLoading)).toBe(false);
      expect(get(cards.cardLoadSource)).toBeNull();
      expect(get(cards.cardSaveMessage)).toBeNull();
      expect(get(cards.cardSaveError)).toBeNull();
    } finally {
      release.resolve();
      await loading;
    }
    expect(remote.http.fetch).not.toHaveBeenCalled();
  });
});
