import { historicalStorage } from './helpers/historicalStorage';
import { saveRepositoryPrototype } from './helpers/saveRepository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { get } from 'svelte/store';
import { parseMarkdownDocument } from '../domain/markdown';
import { documentSlug, mockCardDocumentHttp } from './helpers/cardDocumentHttp';
import { makeCard, NOW } from './helpers/fixtures';
import legacy from './fixtures/migration-legacy.md?raw';
import migrated from './fixtures/migration-v1.md?raw';
import legacyWithAlt from './fixtures/legacy-card.md?raw';
import v1 from './fixtures/v1-card.md?raw';
import future from './fixtures/unsupported-version.md?raw';
import unknownMetadata from './fixtures/v1-unsupported-metadata.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));

let remote: ReturnType<typeof mockCardDocumentHttp>;
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  remote = mockCardDocumentHttp(legacy);
  db = (await import('../services/dbService')).dbService;
  cards = await import('../stores/cardStore');
  const service = (await import('../services/cloudService')).cloudService;
  setLegacyClientToken(service, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
});

afterEach(() => remote.http.assertHandled());

function fixtureCard(source: string) {
  const result = parseMarkdownDocument(source);
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error('Expected a valid fixture');
  return result.document.card;
}

describe('opened document: explicit migration through the real card store', () => {
  it('migrates the exact downloaded source, retains timestamps and only changes the editor draft', async () => {
    await cards.loadCard(documentSlug);
    const cachedBefore = await db.getCard('test-card');
    const write = vi.spyOn(db, 'saveCard');
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');
    const card = fixtureCard(migrated);

    expect(cards.migrateCurrentCardFormat()).toEqual({
      status: 'success', source: legacy,
      document: { version: 1, source: migrated, card },
      appliedSteps: [{ fromVersion: 0, toVersion: 1 }]
    });
    expect(get(cards.cardStore)).toMatchObject(card);
    expect(remote.downloads).toEqual([legacy]);
    expect(write).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(await db.getCard('test-card')).toEqual(cachedBefore);
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(legacy);
  });

  it('retains the exact CRLF input until successful migration', async () => {
    const source = legacy.replaceAll('\n', '\r\n');
    remote = mockCardDocumentHttp(source);
    await cards.loadCard(documentSlug);
    expect(cards.migrateCurrentCardFormat()).toEqual({
      status: 'success', source,
      document: { version: 1, source: migrated, card: fixtureCard(migrated) },
      appliedSteps: [{ fromVersion: 0, toVersion: 1 }]
    });
    expect(remote.readRemoteSource()).toBe(source);
    expect(remote.uploads).toEqual([]);
  });

  it('a repeated action on the current v1 document is idempotent without writes', async () => {
    remote = mockCardDocumentHttp(v1);
    await cards.loadCard(documentSlug);
    const expected = {
      status: 'success', source: v1,
      document: { version: 1, source: v1, card: fixtureCard(v1) }, appliedSteps: []
    };
    expect(cards.migrateCurrentCardFormat()).toEqual(expected);
    expect(cards.migrateCurrentCardFormat()).toEqual(expected);
    expect(remote.uploads).toEqual([]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('local snapshot: saves migrated v1 to the opened filename, with one timestamp in upload, cache and editor', async () => {
    await cards.loadCard(documentSlug);
    const migration = cards.migrateCurrentCardFormat();
    expect(migration).toMatchObject({ status: 'success', appliedSteps: [{ fromVersion: 0, toVersion: 1 }] });
    const draft = get(cards.cardStore);
    expect(draft).toMatchObject(fixtureCard(migrated));
    if (!draft) throw new Error('Expected a migrated draft');
    const expected = migrated.replace('2026-09-24T00:00:00.000Z', new Date(NOW).toISOString());
    const writes: string[] = [];
    const prototype = await saveRepositoryPrototype();
    const persist = prototype.save;
    vi.spyOn(await saveRepositoryPrototype(), 'save').mockImplementation(async function (this: Awaited<ReturnType<typeof saveRepositoryPrototype>>, snapshot) {
      writes.push(snapshot.document.source);
      const result = await persist.call(this, snapshot);
      vi.setSystemTime(NOW + 1234);
      return result;
    });

    await cards.saveCard(documentSlug, draft);

    remote.assertUploaded(expected);
    expect(await db.getCard('test-card')).toMatchObject(fixtureCard(expected));
    expect(get(cards.cardStore)).toMatchObject(fixtureCard(expected));
    expect(writes).toEqual([expected]);
    expect(get(cards.cardSaveError)).toBeNull();
  });

  it.each([
    ['legacy with image alt', legacyWithAlt, 'unsupported', 'unsupported-content'],
    ['future format', future, 'unsupported', 'unknown-version'],
    ['unknown v1 metadata', unknownMetadata, 'unsupported', 'unsupported-content'],
    ['invalid v1 timestamp', v1.replace('2026-09-25T12:34:56.789Z', '2026-09-25'), 'invalid', 'invalid-timestamp']
  ])('returns the complete original %s on refusal and leaves it untouched', async (_, source, status, reason) => {
    remote = mockCardDocumentHttp(source);
    await cards.loadCard(documentSlug);
    const before = get(cards.cardStore);
    const write = vi.spyOn(db, 'saveCard');
    expect(cards.migrateCurrentCardFormat()).toEqual({ status, source, reason });
    expect(get(cards.cardStore)).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(source);
  });
});

describe('save protection also applies when the UI is bypassed', () => {
  it.each([
    ['unmigrated legacy', legacy],
    ['future version', future],
    ['unknown metadata', unknownMetadata],
    ['invalid timestamp', v1.replace('2026-09-25T12:34:56.789Z', '2026-09-25')],
    ['invalid id', v1.replace('\ntest-card\n', '\n../outside\n')]
  ])('refuses a direct save over the opened %s before persistence or upload', async (_, source) => {
    remote = mockCardDocumentHttp(source);
    await cards.loadCard(documentSlug);
    const originalEditor = get(cards.cardStore);
    const write = vi.spyOn(db, 'saveCard');
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');

    // A valid replacement Card does not authorize overwriting a source that
    // could not be fully parsed or has not been explicitly migrated.
    await cards.saveCard(documentSlug, makeCard({ title: 'Must not overwrite source' }));

    expect(get(cards.cardSaveError)).toEqual(expect.any(String));
    expect(get(cards.cardSaveError)).not.toBe('');
    expect(write).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(source);
    expect(get(cards.cardStore)).toEqual(originalEditor);
    expect(get(cards.cardSaving)).toBe(false);
  });

  it('refuses a direct save after migration failed without modifying the source', async () => {
    remote = mockCardDocumentHttp(legacyWithAlt);
    await cards.loadCard(documentSlug);
    expect(cards.migrateCurrentCardFormat()).toEqual({
      status: 'unsupported', source: legacyWithAlt, reason: 'unsupported-content'
    });
    await cards.saveCard(documentSlug, makeCard());
    expect(get(cards.cardSaveError)).toEqual(expect.any(String));
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(legacyWithAlt);
  });
});
