import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb';
import type { Card } from '../domain/types';
import type { OutboxOperation } from '../domain/outbox';
import { NOW, storedCard } from './helpers/fixtures';
import { makeReadFile, mockMarkdownReadHttp } from './helpers/markdownReadHttp';
import { onDocumentDownload } from './helpers/documentDownloadHttp';
import { v1, v1Card, futureV1Shape } from './helpers/markdownReadFixtures';

const initialCard = { ...v1Card, title: 'Initial cached Card' };
const initialSource = futureV1Shape.replace('# Карточка 🗂', '# Initial cached source');
const localCard = { ...v1Card, title: 'Local Save' };
const localSource = (v1.replace('# Карточка 🗂', '# Local Save') + '\n\n').replaceAll('\n', '\r\n');
const remoteSource = v1.replaceAll('\n', '\r\n');
type State = Record<string, unknown[]>;
let db: typeof import('../services/dbService')['dbService'];
let cache: typeof import('../services/cacheManager')['cacheManager'];
let RefreshRepository: typeof import('../adapters/indexedDb/remoteMarkdownCacheRepository')['IndexedDbRemoteMarkdownCacheRepository'];
let remote: ReturnType<typeof mockMarkdownReadHttp>;
let connection: IDBDatabase;

function seed(store: string, row: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(store, 'readwrite');
    tx.objectStore(store).put(row);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

function readState(): Promise<State> {
  return new Promise((resolve, reject) => {
    const names = [...connection.objectStoreNames];
    const tx = connection.transaction(names, 'readonly');
    const requests = names.map(name => tx.objectStore(name).getAll());
    tx.oncomplete = () => resolve(Object.fromEntries(names.map((name, i) => [name, requests[i].result])));
    tx.onabort = () => reject(tx.error);
  });
}

function withRemote(before: State, filename: string, card = v1Card, source = remoteSource): State {
  const cards = [...(before.cards as Card[]).filter(row => row.meta.id !== card.meta.id), storedCard(card, filename)]
    .sort((a, b) => a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0);
  const documents = [...(before.markdownDocuments as { filename: string; source: string }[])
    .filter(row => row.filename !== filename), { filename, source }]
    .sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  return { ...before, cards, markdownDocuments: documents };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  remote = mockMarkdownReadHttp([]);
  db = (await import('../services/dbService')).dbService;
  cache = (await import('../services/cacheManager')).cacheManager;
  RefreshRepository = (await import('../adapters/indexedDb/remoteMarkdownCacheRepository')).IndexedDbRemoteMarkdownCacheRepository;
  await db.saveCard(initialCard);
  connection = await new Promise((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await seed('files', { path: 'unrelated.md', name: 'unrelated.md', modified: 'keep metadata' });
});

afterEach(() => remote.http.assertHandled());

// The second filename is not the Card ID, even though the projection exists.
// It exercises the cloud-only filename branch without assuming an absent Card.
describe.each([
  ['known Card filename', v1Card.meta.id],
  ['new cloud filename', 'Архив.md.🗂']
])('background refresh: %s', (_label, filename) => {
  const file = makeReadFile({ name: `${filename}.md` });

  beforeEach(async () => {
    await db.saveMarkdownDocument(filename, initialSource);
    // Listing still merges metadata. Seed that same DTO so the six-store oracle
    // isolates document protection instead of mistaking a valid listing for loss.
    await seed('files', { name: file.name, path: file.name, modified: file.modified });
    remote = mockMarkdownReadHttp([{ file, source: remoteSource }]);
  });

  // Hold real HTTP, not CacheManager or storage. The local action completes
  // while download is in flight; always release it even if an assertion fails.
  async function duringDownload(action: () => Promise<void>) {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    onDocumentDownload(remote.http, file, () => {
      started.resolve();
      return response.promise;
    });
    const refreshing = cache.validateCache();
    try {
      const phase = await Promise.race([
        started.promise.then(() => 'downloading'), refreshing.then(() => 'finished')
      ]);
      expect(phase).toBe('downloading');
      await action();
    } finally {
      response.resolve(new Response(remoteSource));
      await refreshing;
    }
  }

  it('retains a historical local snapshot and exact cached source without acknowledging it', async () => {
    await historicalStorage.saveLocalMarkdownSnapshot({ filename, source: localSource, saveMode: 'update' });
    const before = await readState();

    await cache.validateCache();

    expect(await readState()).toEqual(before);
    expect(remote.downloads).toEqual([]);
  });

  it('retains an undelivered outbox operation by Card ID under a different filename', async () => {
    const operation: OutboxOperation = {
      id: 'pending-save', cardId: v1Card.meta.id, path: 'another-path.md', source: localSource,
      createOnly: false, base: { kind: 'present', revision: 'base' }, createdAt: NOW, attempts: 0,
      state: { status: 'pending', nextAttemptAt: NOW }
    };
    await seed('outbox', operation);
    const before = await readState();

    await cache.validateCache();

    expect(await readState()).toEqual(before);
  });

  it.each([false, true])('retains a Save made during download (already acknowledged: %s)', async acknowledged => {
    let expected: State = {};
    await duringDownload(async () => {
      const snapshot = { filename, source: localSource, saveMode: 'update' as const };
      await historicalStorage.saveLocalMarkdownSnapshot(snapshot);
      if (acknowledged) {
        // Seed the historical acknowledged state directly; its retired producer is gone.
        await db.saveMarkdownDocument(filename, localSource);
        await new Promise<void>((resolve, reject) => {
          const tx = connection.transaction('localMarkdownSnapshots', 'readwrite');
          tx.objectStore('localMarkdownSnapshots').delete(filename);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      }
      expected = await readState();
    });

    expect(await readState()).toEqual(expected);
    expect(await db.getCard(v1Card.meta.id)).toEqual(storedCard(localCard));
  });

  it('retains a Card changed during download even without a draft or timestamp change', async () => {
    let expected: State = {};
    await duringDownload(async () => {
      await db.saveCard(localCard);
      expected = await readState();
    });

    expect(await readState()).toEqual(expected);
  });

  it('retains a source changed during download even when the Card is unchanged', async () => {
    let expected: State = {};
    await duringDownload(async () => {
      await db.saveMarkdownDocument(filename, localSource);
      expected = await readState();
    });

    expect(await readState()).toEqual(expected);
  });

  it('rolls back a failed Card write, continues with the next file and permits a later explicit refresh', async () => {
    const goodName = 'zzz-next-card';
    const goodCard = { ...v1Card, meta: { ...v1Card.meta, id: goodName } };
    const goodSource = remoteSource.replace('\r\ntest-card\r\n', `\r\n${goodName}\r\n`);
    const goodFile = makeReadFile({ name: `${goodName}.md` });
    await seed('files', { name: goodFile.name, path: goodFile.name, modified: goodFile.modified });
    remote = mockMarkdownReadHttp([
      { file, source: remoteSource },
      { file: goodFile, source: goodSource }
    ]);
    const before = await readState();
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'cards' && (args[0] as Card).meta.id === v1Card.meta.id) {
        throw new DOMException('Cannot persist this Card', 'QuotaExceededError');
      }
      return put.apply(this, args);
    });

    try {
      await cache.validateCache();
    } finally {
      failure.mockRestore();
    }

    expect(await readState()).toEqual(withRemote(before, goodName, goodCard, goodSource));
    remote.http.assertHandled();
    // A storage failure must also release CacheManager's validation guard.
    remote = mockMarkdownReadHttp([{ file, source: remoteSource }]);
    await cache.validateCache();
    expect(await readState()).toEqual(withRemote(withRemote(before, goodName, goodCard, goodSource), filename));
  });

  it('does not download or overwrite when the pre-download source capture fails', async () => {
    const before = await readState();
    const transaction = IDBDatabase.prototype.transaction;
    const failure = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      const names = typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]);
      if (args[1] !== 'readwrite' && names.includes('markdownDocuments')) {
        throw new DOMException('Cannot capture previous source', 'InvalidStateError');
      }
      return transaction.apply(this, args);
    });

    try {
      await cache.validateCache();
    } finally {
      failure.mockRestore();
    }

    expect(await readState()).toEqual(before);
    expect(remote.downloads).toEqual([]);
    await cache.validateCache();
    expect(await readState()).toEqual(withRemote(before, filename));
  });

  // Replaces the two background persistence-gate cases in downloadedDocumentCache.
  // Editor/board retain their independent raw-source repository contract there.
  it('waits for atomic refresh completion before completing validation or publishing a Card', async () => {
    const before = await readState();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refresh = RefreshRepository.prototype.refresh;
    vi.spyOn(RefreshRepository.prototype, 'refresh').mockImplementation(async function (this: InstanceType<typeof RefreshRepository>, input) {
      started.resolve();
      await release.promise;
      return refresh.call(this, input);
    });
    let isFinished = false;
    const refreshing = cache.validateCache().finally(() => { isFinished = true; });

    try {
      const phase = await Promise.race([
        started.promise.then(() => 'persisting'), refreshing.then(() => 'finished')
      ]);
      expect(phase).toBe('persisting');
      expect(await readState()).toEqual(before);
      expect(isFinished).toBe(false);
    } finally {
      release.resolve();
      await refreshing;
    }

    expect(await readState()).toEqual(withRemote(before, filename));
  });
});
