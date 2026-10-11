import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { mockNewCardDocumentHttp } from './helpers/newCardDocumentHttp';
import { readStoredOperations } from './helpers/indexedDb';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { NOW } from './helpers/fixtures';

vi.mock('$app/environment', () => ({ browser: true }));

const filename = 'archive.md.заметка';
const missingContextMessage = 'Сохранение недоступно без контекста документа. Откройте заметку заново.';
let remote: ReturnType<typeof mockNewCardDocumentHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cards: typeof import('../stores/cardStore');
let cloud: typeof import('../stores/cloudStore');

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  remote = mockNewCardDocumentHttp();
  db = (await import('../services/dbService')).dbService;
  cards = await import('../stores/cardStore');
  cloud = await import('../stores/cloudStore');
  await cloud.checkIsSessionAuthenticated();
  remote.files.set(`${filename}.md`, v1);
  remote.http.fetch.mockClear();
});

afterEach(() => remote.http.assertHandled());

async function readLocalState() {
  return {
    cards: await db.getAllCards(),
    files: await historicalStorage.getAllCloudFiles(),
    source: await db.getMarkdownDocument(filename),
    snapshot: await db.getLocalMarkdownSnapshot(filename),
    operations: await readStoredOperations()
  };
}

describe.each(['saveCard'] as const)('%s without an authorized save path', api => {
  it.each(['no local records', 'retained source and pending snapshot'] as const)('refuses with %s, preserving the draft and stored versions', async localState => {
    if (localState !== 'no local records') {
      await db.saveMarkdownDocument(filename, v1.replaceAll('\n', '\r\n'));
      await historicalStorage.saveLocalMarkdownSnapshot({ filename, source: v1, saveMode: 'update' });
      await historicalStorage.queueSyncOperation({ id: 'retained-operation', type: 'update', card: v1Card,
        timestamp: NOW - 60_000, attempts: 2 });
    }
    const draft = { ...structuredClone(v1Card), title: 'Unsaved memory edit',
      _metadata: { source: 'memory' as const, loadTime: 42 } };
    cards.cardStore.set(draft);
    cards.cardLoadSource.set('indexeddb');
    cards.cardLoadTime.set(42);
    const draftBefore = structuredClone(draft);
    const before = await readLocalState();
    const remoteBefore = [...remote.files];
    const syncBefore = get(cloud.syncStatus);

    await cards.saveCard(filename, draft);
    expect(get(cards.cardSaveError)).toBe(missingContextMessage);
    expect(get(cards.cardSaveMessage)).toBeNull();

    expect(remote.uploads, 'Never serialize a bare Card to overwrite a document').toEqual([]);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect([...remote.files]).toEqual(remoteBefore);
    expect(await readLocalState()).toEqual(before);
    expect(get(cards.cardDocument)).toBeNull();
    expect(get(cards.cardStore)).toEqual(draftBefore);
    expect(draft).toEqual(draftBefore);
    expect(get(cards.cardSaving)).toBe(false);
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    expect(get(cards.cardLoadTime)).toBe(42);
    expect(get(cards.isOffline)).toBe(false);
    expect(get(cloud.syncStatus)).toEqual(syncBefore);
  });
});

it('replaces a stale success message with the missing-context error without changing time or connectivity state', async () => {
  const draft = { ...structuredClone(v1Card), title: 'Unsaved edit' };
  cards.cardStore.set(draft);
  cards.cardSaveMessage.set('Сохранено на Диске.');
  cards.isOffline.set(true);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  remote.setFailure('network');
  const before = structuredClone(draft);

  await cards.saveCard(filename, draft);

  expect(get(cards.cardSaveError)).toBe(missingContextMessage);
  expect(get(cards.cardSaveMessage)).toBeNull();
  expect(get(cards.cardStore)).toEqual(before);
  expect(draft).toEqual(before);
  expect(get(cards.isOffline)).toBe(true);
  expect(get(cards.cardSaving)).toBe(false);
  expect(remote.http.fetch).not.toHaveBeenCalled();
});
