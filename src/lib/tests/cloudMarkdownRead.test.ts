import { saveRepositoryPrototype } from './helpers/saveRepository';
import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { makeCard, NOW, storedCard } from './helpers/fixtures';
import { makeReadFile, mockMarkdownReadHttp } from './helpers/markdownReadHttp';
import { rejectedMarkdown, unknownMetadata, v1, v1Card } from './helpers/markdownReadFixtures';

vi.mock('$app/environment', () => ({ browser: true }));

let remote: ReturnType<typeof mockMarkdownReadHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cloud: typeof import('../stores/cloudStore');

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  remote = mockMarkdownReadHttp([{ file: makeReadFile(), source: v1 }]);
  db = (await import('../services/dbService')).dbService;
  cloud = await import('../stores/cloudStore');
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await cloud.checkIsSessionAuthenticated();
});

afterEach(() => remote.http.assertHandled());

describe('board loader: strict downloaded Markdown', () => {
  // Replaces the cloudWorkflow characterization that required remote mtime
  // to overwrite meta.modified. The document owns its semantic timestamps.
  it('refreshes an older cached card with complete v1 and keeps document timestamps instead of remote mtime', async () => {
    await db.saveCard(makeCard({ title: 'Сохранённая карточка' }));
    const write = vi.spyOn(db, 'saveCard');

    const result = await cloud.loadCardFromCloud(makeReadFile());

    expect(result).toEqual(v1Card);
    expect(await db.getCard(v1Card.meta.id)).toMatchObject(v1Card);
    expect(await db.getCard('test-card')).toEqual(storedCard(v1Card));
    expect(remote.downloads).toEqual([{ filename: 'test-card.md', source: v1 }]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('reads CRLF v1 from a differently named file without changing its ID or empty ordered section', async () => {
    const file = makeReadFile({ name: 'existing-note.md', path: 'disk:/md-cards/existing-note.md' });
    const source = v1.replaceAll('\n', '\r\n');
    remote = mockMarkdownReadHttp([{ file, source }]);

    const result = await cloud.loadCardFromCloud(file);

    expect(result).toEqual(v1Card);
    expect(await db.getCard('test-card')).toEqual(storedCard(v1Card, 'existing-note'));
    expect(await db.getCard('existing-note')).toBeNull();
    expect(remote.downloads).toEqual([{ filename: file.name, source }]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it.each(rejectedMarkdown)('refuses %s without replacing or partially extending the existing cache', async (_, source) => {
    const local = makeCard({ title: 'Сохранённая карточка' });
    await db.saveCard(local);
    const before = await db.getAllCards();
    remote = mockMarkdownReadHttp([{ file: makeReadFile(), source }]);
    const write = vi.spyOn(db, 'saveCard');
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');

    const result = await cloud.loadCardFromCloud(makeReadFile());

    expect(result).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(await db.getAllCards()).toEqual(before);
    expect(remote.downloads).toEqual([{ filename: 'test-card.md', source }]);
  });

  it('refuses unknown metadata with no local copy instead of caching a partial card', async () => {
    remote = mockMarkdownReadHttp([{ file: makeReadFile(), source: unknownMetadata }]);
    const write = vi.spyOn(db, 'saveCard');

    const result = await cloud.loadCardFromCloud(makeReadFile());

    expect(result).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(await db.getAllCards()).toEqual([]);
    expect(remote.downloads).toEqual([{ filename: 'test-card.md', source: unknownMetadata }]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });
});
