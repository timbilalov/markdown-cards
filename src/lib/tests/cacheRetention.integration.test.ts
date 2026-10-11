import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../domain/types';
import type { OutboxOperation, OutboxState } from '../domain/outbox';
import { DAY, NOW, fileList, makeFile, storedCard } from './helpers/fixtures';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { mockHttp } from './helpers/http';
import { onCloudFileList } from './helpers/cloudListHttp';

const filename = 'Архив.md.🗂'; // Deliberately different from Card ID.
const card: Card = {
  ...v1Card,
  meta: { id: v1Card.meta.id, created: NOW - 60 * DAY, modified: NOW - 40 * DAY }
};
const source = (v1
  .replace('2026-09-01T08:09:10.123Z', new Date(card.meta.created).toISOString())
  .replace('2026-09-25T12:34:56.789Z', new Date(card.meta.modified).toISOString())
  + '\n\n').replaceAll('\n', '\r\n');
const pendingSnapshot = { filename, source, saveMode: 'update' as const };
const operation: OutboxOperation = {
  id: 'save-current', cardId: card.meta.id, path: `${filename}.md`, source,
  createOnly: false, base: { kind: 'present', revision: 'opaque-base' },
  createdAt: card.meta.modified, attempts: 2,
  state: { status: 'pending', nextAttemptAt: card.meta.modified }
};
const states: OutboxState[] = [
  { status: 'pending', nextAttemptAt: NOW + DAY },
  { status: 'processing', deliveryId: 'active-delivery', startedAt: NOW - DAY },
  { status: 'failed', reason: 'network', nextAttemptAt: NOW + DAY },
  { status: 'failed', reason: 'auth', nextAttemptAt: null },
  { status: 'uncertain', deliveryId: 'lost-response', reason: 'interrupted' },
  { status: 'conflict' }
];
type Maintenance = 'validateCache';
let db: typeof import('../services/dbService')['dbService'];
let cache: typeof import('../services/cacheManager')['cacheManager'];
let http: ReturnType<typeof mockHttp>;
let database: IDBDatabase;

function openCurrent(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Seed physical records independently of the new Save/recovery APIs. This also
// models historical rows that cannot be assumed to have a trustworthy base.
function seed(rows: Record<string, unknown[]>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(Object.keys(rows), 'readwrite');
    for (const [store, records] of Object.entries(rows)) {
      for (const record of records) tx.objectStore(store).put(record);
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

function readState(): Promise<Record<string, unknown[]>> {
  return new Promise((resolve, reject) => {
    const names = [...database.objectStoreNames];
    const tx = database.transaction(names, 'readonly');
    const requests = names.map(name => tx.objectStore(name).getAll());
    tx.oncomplete = () => resolve(Object.fromEntries(names.map((name, i) => [name, requests[i].result])));
    tx.onabort = () => reject(tx.error);
  });
}

async function expectRetention(method: Maintenance): Promise<void> {
  const before = await readState();
  const remove = vi.spyOn(db, 'deleteCard');
  await cache[method]();
  expect(await db.getCard(card.meta.id)).toEqual(storedCard(card));
  expect(await readState()).toEqual(before);
  expect(remove).not.toHaveBeenCalled();
  // Retention must not disable validation itself; only age-based eviction goes.
  const listCalls = http.fetch.mock.calls.filter(([url]) => String(url) === '/api/cloud/files');
  expect(listCalls).toHaveLength(method === 'validateCache' ? 1 : 0);
  expect(http.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  http = mockHttp();
  onCloudFileList(http, () => Response.json(fileList()));
  db = (await import('../services/dbService')).dbService;
  cache = (await import('../services/cacheManager')).cacheManager;
  await db.saveCard(card);
  database = await openCurrent();
  await seed({ files: [makeFile({ name: 'unrelated.md', path: 'unrelated.md' })] });
});

afterEach(() => http.assertHandled());

// Replace the two old KNOWN DEFECT deletion assertions with the safe contract.
describe.each(['validateCache'] as const)('%s: age and listing are not eviction evidence', method => {
  it('preserves the sole local Card when the cloud folder is empty', async () => {
    await expectRetention(method);
  });

  it('preserves an old Card and its legacy pending update', async () => {
    await historicalStorage.queueSyncOperation({
      id: 'legacy-pending', type: 'update', card, path: `${filename}.md`,
      timestamp: card.meta.modified, attempts: 3
    });
    await expectRetention(method);
  });

  it('preserves an unacknowledged historical snapshot even when an older remote source is cached', async () => {
    await seed({
      localMarkdownSnapshots: [pendingSnapshot],
      markdownDocuments: [{ filename, source: source.replace('Первый абзац', 'Old remote paragraph') }]
    });
    await expectRetention(method);
  });

  it.each(states)('preserves current Save and $status metadata without acknowledgement or recovery', async state => {
    await seed({
      outbox: [{ ...operation, state }],
      localMarkdownSnapshots: [{ ...pendingSnapshot, saveId: operation.id }],
      markdownDocuments: [{ filename, source: source.replace('Первый абзац', 'Old remote paragraph') }]
    });
    await expectRetention(method);
  });

  it('does not treat historical completion and cached source as proof that the current Card is disposable', async () => {
    await seed({
      outbox: [{ ...operation, state: { status: 'completed', revision: 'old-revision', completedAt: NOW - 39 * DAY } }],
      markdownDocuments: [{ filename, source }]
    });
    await expectRetention(method);
  });
});
