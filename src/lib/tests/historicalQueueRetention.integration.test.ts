import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { historicalStorage } from './helpers/historicalStorage';
import { readStoredOperations } from './helpers/indexedDb';
import { readLegacyDatabase, seedLegacyDatabase, legacyRecords } from './helpers/legacyDatabase';
import { makeCard, NOW } from './helpers/fixtures';
import { mockHttp } from './helpers/http';
import { v1 } from './helpers/markdownReadFixtures';
import { rejectedMarkdown } from './helpers/markdownReadFixtures';
vi.mock('$app/environment', () => ({ browser: true }));
let http: ReturnType<typeof mockHttp>;
beforeEach(() => { vi.resetModules(); http = mockHttp(); });
afterEach(() => http.assertHandled());

it('retains every old queue status and Card when upgrading v2 and running the active worker', async () => {
  await seedLegacyDatabase();
  await (await import('../services/cardSyncRuntime')).retryCardSync(true);
  const upgraded = await readLegacyDatabase();
  expect(upgraded.version).toBe(5);
  expect(upgraded.records).toEqual({ ...legacyRecords, syncQueue: [...legacyRecords.syncQueue].sort((a, b) => a.id.localeCompare(b.id)) });
  expect(http.fetch).not.toHaveBeenCalled();
});

it.each(['create', 'update', 'delete'] as const)('never replays a historical %s row, including after reload', async type => {
  await historicalStorage.queueSyncOperation({ id: 'retained', type, card: makeCard(), cardId: 'test-card', timestamp: NOW, attempts: 4 });
  const before = await readStoredOperations();
  await (await import('../services/cardSyncRuntime')).retryCardSync(true);
  vi.resetModules();
  await (await import('../services/cardSyncRuntime')).retryCardSync(true);
  expect(await readStoredOperations()).toEqual(before);
  expect(http.fetch).not.toHaveBeenCalled();
});

it.each([['v1', v1] as const, ...rejectedMarkdown])('retains %s source and a historical local draft without cloud writes', async (_name, source) => {
  const db = (await import('../services/dbService')).dbService;
  await db.saveMarkdownDocument('test-card', source);
  await historicalStorage.saveLocalMarkdownSnapshot({ filename: 'test-card', source: v1, saveMode: 'update' });
  await historicalStorage.queueSyncOperation({ id: 'retained', type: 'update', card: makeCard(), timestamp: NOW, attempts: 4 });
  const before = await readStoredOperations();
  const cached = await db.getMarkdownDocument('test-card');
  await (await import('../services/cardSyncRuntime')).retryCardSync(true);
  expect(await readStoredOperations()).toEqual(before);
  expect(await db.getMarkdownDocument('test-card')).toEqual(cached);
  expect(await db.getLocalMarkdownSnapshot('test-card')).toEqual({ filename: 'test-card', source: v1, saveMode: 'update' });
  expect(http.fetch).not.toHaveBeenCalled();
});
