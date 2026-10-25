import { saveRepositoryPrototype } from './helpers/saveRepository';
import { historicalStorage } from './helpers/historicalStorage';
import { IDBObjectStore } from 'fake-indexeddb';
import { onDocumentDownload } from './helpers/documentDownloadHttp';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { MarkdownParseResult } from '../domain/types';
import type { CloudFile } from '../types/cloud';
import { makeCard, NOW, storedCard } from './helpers/fixtures';
import { makeReadFile, mockMarkdownReadHttp } from './helpers/markdownReadHttp';
import { v1, v1Card, futureV1Shape, unknownMetadata } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));

const paths = ['editor', 'board', 'background refresh', 'background new file'] as const;
type ReadPath = typeof paths[number];
const filename = 'test-card';
const oldSource = futureV1Shape.replace('# Карточка 🗂', '# Previous remote source');
const local = makeCard({ title: 'Existing local Card' });
const crlfV1 = v1.replaceAll('\n', '\r\n');
const crlfLegacy = legacy.replaceAll('\n', '\r\n');
const badTimestamp = v1.replace('2026-09-25T12:34:56.789Z', 'not-a-date');

const sourceCases: { label: string; source: string; result: MarkdownParseResult }[] = [
  { label: 'complete v1 with CRLF', source: crlfV1,
    result: { status: 'success', document: { version: 1, source: crlfV1, card: v1Card } } },
  { label: 'legacy with CRLF', source: crlfLegacy,
    result: { status: 'unsupported', source: crlfLegacy, reason: 'missing-version' } },
  { label: 'future version', source: futureV1Shape,
    result: { status: 'unsupported', source: futureV1Shape, reason: 'unknown-version' } },
  { label: 'unknown metadata', source: unknownMetadata,
    result: { status: 'unsupported', source: unknownMetadata, reason: 'unsupported-content' } },
  { label: 'invalid timestamp', source: badTimestamp,
    result: { status: 'invalid', source: badTimestamp, reason: 'invalid-timestamp' } }
];

let remote: ReturnType<typeof mockMarkdownReadHttp>;
let db: typeof import('../services/dbService')['dbService'];
let DBService: typeof import('../services/dbService')['DBService'];
let cards: typeof import('../stores/cardStore');
let cloud: typeof import('../stores/cloudStore');
let cache: typeof import('../services/cacheManager')['cacheManager'];

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  remote = mockMarkdownReadHttp([]);
  ({ dbService: db, DBService } = await import('../services/dbService'));
  cards = await import('../stores/cardStore');
  cloud = await import('../stores/cloudStore');
  cache = (await import('../services/cacheManager')).cacheManager;
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await cloud.checkIsSessionAuthenticated();
});

afterEach(() => remote.http.assertHandled());

function makeNamedFile(name = filename): CloudFile {
  return makeReadFile({ name: `${name}.md`, path: `disk:/md-cards/${name}.md`,
    file: `https://downloader.disk.yandex.ru/${encodeURIComponent(name)}` });
}

async function read(path: ReadPath, file = makeNamedFile(), name = filename) {
  if (path === 'editor') return cards.loadCard(name);
  if (path === 'board') return cloud.loadCardFromCloud(file);
  return cache.validateCache();
}

function expectedV1(name = filename, source = v1) {
  return { filename: name, result: { status: 'success', document: { version: 1, source, card: v1Card } } };
}

describe.each(paths)('%s: downloaded source reaches durable document storage', path => {
  beforeEach(async () => {
    if (path !== 'background new file') await db.saveCard(local);
  });

  it.each(sourceCases)('retains the exact $label after reading, including refused content', async ({ source, result }) => {
    remote = mockMarkdownReadHttp([{ file: makeNamedFile(), source }]);
    const before = await db.getAllCards();
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');

    const loaded = await read(path);

    // A separate DBService must read the actual persisted source, not store memory.
    expect(await new DBService().getMarkdownDocument(filename)).toEqual({ filename, result });
    if (path === 'editor') {
      expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, result });
      expect(await db.getAllCards()).toEqual(before);
    } else if (result.status === 'success') {
      expect(await db.getCard(filename)).toEqual(storedCard(v1Card));
      if (path === 'board') expect(loaded).toEqual({ status: 'loaded', card: v1Card });
    } else {
      expect(await db.getAllCards()).toEqual(before);
      if (path === 'board') expect(loaded).toEqual({ status: 'unprojected' });
    }
    expect(remote.downloads).toEqual([{ filename: `${filename}.md`, source }]);
    expect(queue).not.toHaveBeenCalled();
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('refreshes a previous remote source instead of leaving its old format or text in the cache', async () => {
    await db.saveMarkdownDocument(filename, oldSource);
    remote = mockMarkdownReadHttp([{ file: makeNamedFile(), source: v1 }]);

    await read(path);

    expect(await new DBService().getMarkdownDocument(filename)).toEqual(expectedV1());
    expect(remote.downloads).toEqual([{ filename: `${filename}.md`, source: v1 }]);
  });

  // Background waits now exercise the atomic repository in backgroundCacheRefresh.
  if (path === 'editor' || path === 'board') it('waits for source persistence before completing the read or publishing a new Card', async () => {
    remote = mockMarkdownReadHttp([{ file: makeNamedFile(), source: v1 }]);
    const before = await db.getAllCards();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const persist = db.refreshMarkdownCache.bind(db);
    vi.spyOn(db, 'refreshMarkdownCache').mockImplementation(async input => {
      started.resolve();
      await release.promise;
      return await persist(input);
    });
    let isFinished = false;
    const loading = read(path).finally(() => { isFinished = true; });

    try {
      const phase = await Promise.race([
        started.promise.then(() => 'persisting'), loading.then(() => 'finished')
      ]);
      expect(phase).toBe('persisting');
      expect(await db.getAllCards()).toEqual(before);
      expect(isFinished).toBe(false);
      if (path === 'editor') expect(get(cards.cardLoading)).toBe(true);
    } finally {
      release.resolve();
      await loading;
    }
    expect(await new DBService().getMarkdownDocument(filename)).toEqual(expectedV1());
  });

  it('handles source-cache failure without replacing an older cached source or publishing an uncached background Card', async () => {
    await db.saveMarkdownDocument(filename, oldSource);
    const before = await db.getAllCards();
    remote = mockMarkdownReadHttp([{ file: makeNamedFile(), source: v1 }]);
    const { DBTransactionError } = await import('../services/dbService');
    const failure = new DBTransactionError('Source transaction aborted');
    const isBackground = path === 'background refresh' || path === 'background new file';
    const put = IDBObjectStore.prototype.put;
    const persist = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'markdownDocuments') throw failure;
      return put.apply(this, args);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await read(path);

    if (path === 'editor') {
      // A failed cache write must not discard the source already downloaded
      // for the user. The warning identifies the filename and original error.
      expect(warning.mock.calls).toContainEqual([expect.stringContaining(filename), failure]);
      expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', ...expectedV1() });
      expect(get(cards.cardStore)).toMatchObject(v1Card);
      expect(get(cards.cardLoadSource)).toBe('cloud');
      expect(get(cards.cardSaveMessage)).toBeNull();
    } else {
      expect(await db.getAllCards()).toEqual(before);
      if (path === 'board') expect(loaded).toEqual({ status: 'unprojected' });
    }
    {
      const sourceWrites = persist.mock.calls.filter((_, i) =>
        (persist.mock.contexts[i] as IDBObjectStore).name === 'markdownDocuments');
      expect(sourceWrites).toEqual([[{ filename, source: v1 }]]);
    }
    expect(await db.getMarkdownDocument(filename)).toEqual({
      filename, result: { status: 'unsupported', source: oldSource, reason: 'unknown-version' }
    });
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });
});

describe.each(['editor', 'board', 'background new file'] as const)('%s: source filename mapping', path => {
  it('uses the original basename, retaining an internal .md and keeping it separate from Card ID', async () => {
    const name = 'archive.md.note';
    const file = makeNamedFile(name);
    remote = mockMarkdownReadHttp([{ file, source: crlfV1 }]);

    await read(path, file, name);

    expect(await new DBService().getMarkdownDocument(name)).toEqual(expectedV1(name, crlfV1));
    expect(await db.getMarkdownDocument(v1Card.meta.id)).toBeNull();
    expect(await db.getMarkdownDocument('archive.note.md')).toBeNull();
    expect(await db.getMarkdownDocument(file.name)).toBeNull();
    expect(remote.downloads).toEqual([{ filename: file.name, source: crlfV1 }]);
    if (path === 'editor') expect(get(cards.cardDocument)).toMatchObject({ filename: name });
  });
});

describe.each(['background refresh', 'background new file'] as const)('%s: independent files', path => {
  it('continues after a source-cache error and durably retains the next complete document', async () => {
    if (path === 'background refresh') await db.saveCard(local);
    await db.saveMarkdownDocument(filename, oldSource);
    const goodName = 'other-card';
    const goodSource = v1.replace('\ntest-card\n', '\nother-card\n');
    const goodCard = { ...v1Card, meta: { ...v1Card.meta, id: goodName } };
    remote = mockMarkdownReadHttp([
      { file: makeNamedFile(), source: v1 },
      { file: makeNamedFile(goodName), source: goodSource }
    ]);
    const put = IDBObjectStore.prototype.put;
    const { DBTransactionError } = await import('../services/dbService');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'markdownDocuments' && args[0].filename === filename) {
        throw new DBTransactionError('First file cannot be cached');
      }
      return put.apply(this, args);
    });

    await cache.validateCache();

    expect(await new DBService().getMarkdownDocument(goodName)).toEqual({ filename: goodName,
      result: { status: 'success', document: { version: 1, source: goodSource, card: goodCard } } });
    expect(await db.getCard(goodName)).toEqual(storedCard(goodCard));
    expect(await db.getCard(filename)).toEqual(path === 'background refresh' ? storedCard(local) : null);
    expect(await db.getMarkdownDocument(filename)).toEqual({
      filename, result: { status: 'unsupported', source: oldSource, reason: 'unknown-version' }
    });
    expect(remote.downloads).toEqual([
      { filename: `${filename}.md`, source: v1 }, { filename: `${goodName}.md`, source: goodSource }
    ]);
  });
});

it('does not let an obsolete editor download replace the source cached by the newer load', async () => {
  const file = makeNamedFile();
  remote = mockMarkdownReadHttp([{ file, source: futureV1Shape }]);
  const requested = Promise.withResolvers<void>();
  const oldResponse = Promise.withResolvers<Response>();
  let attempts = 0;
  onDocumentDownload(remote.http, file, () => {
    if (++attempts === 1) {
      requested.resolve();
      return oldResponse.promise;
    }
    return new Response(futureV1Shape);
  });

  const older = cards.loadCard(filename);
  await requested.promise;
  try {
    await cards.loadCard(filename);
  } finally {
    oldResponse.resolve(new Response(v1));
    await older;
  }

  const result = { status: 'unsupported', source: futureV1Shape, reason: 'unknown-version' };
  expect(await new DBService().getMarkdownDocument(filename)).toEqual({ filename, result });
  expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, result });
  expect(get(cards.cardStore)).toBeNull();
  expect(attempts).toBe(2);
});

it('does not restore an obsolete editor after its cache-write promise completes late', async () => {
  const file = makeNamedFile();
  remote = mockMarkdownReadHttp([{ file, source: v1 }]);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const persist = db.refreshMarkdownCache.bind(db);
  let writes = 0;
  vi.spyOn(db, 'refreshMarkdownCache').mockImplementation(async input => {
    const result = await persist(input);
    if (++writes === 1) {
      started.resolve();
      await release.promise;
    }
    return result;
  });

  const older = cards.loadCard(filename);
  try {
    const phase = await Promise.race([
      started.promise.then(() => 'persisting'), older.then(() => 'finished')
    ]);
    expect(phase).toBe('persisting');
    onDocumentDownload(remote.http, file,
      () => new Response(futureV1Shape));
    await cards.loadCard(filename);
  } finally {
    release.resolve();
    await older;
  }

  const result = { status: 'unsupported', source: futureV1Shape, reason: 'unknown-version' };
  expect(await new DBService().getMarkdownDocument(filename)).toEqual({ filename, result });
  expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', filename, result });
  expect(get(cards.cardStore)).toBeNull();
  expect(get(cards.cardLoading)).toBe(false);
});
