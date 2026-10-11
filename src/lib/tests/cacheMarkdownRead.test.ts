import { saveRepositoryPrototype } from './helpers/saveRepository';
import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { makeCard, NOW, storedCard } from './helpers/fixtures';
import { makeReadFile, mockMarkdownReadHttp } from './helpers/markdownReadHttp';
import { rejectedMarkdown, unknownMetadata, v1, v1Card } from './helpers/markdownReadFixtures';

let remote: ReturnType<typeof mockMarkdownReadHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cache: typeof import('../services/cacheManager')['cacheManager'];

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  remote = mockMarkdownReadHttp([{ file: makeReadFile(), source: v1 }]);
  db = (await import('../services/dbService')).dbService;
  cache = (await import('../services/cacheManager')).cacheManager;
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
});

afterEach(() => remote.http.assertHandled());

describe.each(['existing cache', 'no local copy'] as const)('background format refresh with %s', mode => {
  beforeEach(async () => {
    if (mode === 'existing cache') await db.saveCard(makeCard({ title: 'Сохранённая карточка' }));
  });

  it('caches the complete v1 Card, preserving description, empty list type and precise dates', async () => {
    const source = mode === 'existing cache' ? v1 : v1.replaceAll('\n', '\r\n');
    remote = mockMarkdownReadHttp([{ file: makeReadFile(), source }]);
    await cache.validateCache();

    expect(await db.getAllCards()).toEqual([storedCard(v1Card)]);
    expect(remote.downloads).toEqual([{ filename: 'test-card.md', source }]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it.each(rejectedMarkdown)('keeps local data intact when the download contains %s', async (_, source) => {
    const before = await db.getAllCards();
    remote = mockMarkdownReadHttp([{ file: makeReadFile(), source }]);
    const write = vi.spyOn(db, 'saveCard');
    const remove = vi.spyOn(db, 'deleteCard');
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');

    await cache.validateCache();

    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(await db.getAllCards()).toEqual(before);
    expect(remote.downloads).toEqual([{ filename: 'test-card.md', source }]);
  });
});

it('continues refreshing valid v1 files after refusing a different unsupported document', async () => {
  const local = makeCard({ title: 'Не заменять частичной карточкой' });
  await db.saveCard(local);
  const validFile = makeReadFile({ name: 'valid-card.md', path: 'disk:/md-cards/valid-card.md',
    file: 'https://downloader.disk.yandex.ru/valid-card' });
  const validSource = v1.replace('\ntest-card\n', '\nvalid-card\n');
  const validCard = { ...v1Card, meta: { ...v1Card.meta, id: 'valid-card' } };
  remote = mockMarkdownReadHttp([
    { file: makeReadFile(), source: unknownMetadata },
    { file: validFile, source: validSource }
  ]);
  await cache.validateCache();

  expect(await db.getCard('test-card')).toEqual(storedCard(local));
  expect(await db.getCard('valid-card')).toEqual(storedCard(validCard));
  expect(remote.downloads).toEqual([
    { filename: 'test-card.md', source: unknownMetadata },
    { filename: 'valid-card.md', source: validSource }
  ]);
  expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
});
