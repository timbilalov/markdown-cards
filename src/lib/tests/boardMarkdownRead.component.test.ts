import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { makeCard, NOW, storedCard } from './helpers/fixtures';
import { makeReadFile, mockMarkdownReadHttp } from './helpers/markdownReadHttp';
import { v1, futureV1Shape, unknownMetadata } from './helpers/markdownReadFixtures';

vi.mock('$app/environment', () => ({ browser: true }));

let remote: ReturnType<typeof mockMarkdownReadHttp>;
let db: typeof import('../services/dbService')['dbService'];
let runtime: typeof import('svelte');
let MainPage: typeof import('../../routes/+page.svelte')['default'];
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

const local = makeCard({ title: 'Сохранённая карточка', status: 'Предстоящие',
  image: 'https://example.invalid/local.png' });

beforeEach(async () => {
  vi.resetModules();
  // Keep the page's five-second background validation and DB metrics interval
  // controlled; fake-indexeddb still uses its real asynchronous callbacks.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  remote = mockMarkdownReadHttp([{ file: makeReadFile(), source: futureV1Shape }]);
  runtime = await import('svelte');
  db = (await import('../services/dbService')).dbService;
  await db.saveCard(local);
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  MainPage = (await import('../../routes/+page.svelte')).default;
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.remove();
  remote.http.assertHandled();
});

describe('board with real stores, download and IndexedDB', () => {
  it('shows an unsupported cached filename as a read-only link while offline', async () => {
    await db.saveMarkdownDocument('future-note', futureV1Shape);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    remote = mockMarkdownReadHttp([]);
    component = runtime.mount(MainPage, { target }); runtime.flushSync();
    await vi.waitFor(() => {
      runtime.flushSync();
      expect(target.querySelector('a[href="/card/future-note"]')).not.toBeNull();
    });
    const tile = target.querySelector('a[href="/card/future-note"]')!;
    expect(tile.querySelector('h3')?.textContent).toBe('future-note');
    expect(tile.textContent).toContain('Только чтение');
    expect(await db.getAllCards()).toEqual([storedCard(local)]);
    expect(await db.getMarkdownDocument('future-note')).toMatchObject({ result: { source: futureV1Shape } });
  });

  it.each(['provider auth', 'invalid list'])('shows %s as a cloud error without claiming the browser is offline', async kind => {
    remote.http.on('GET', '/api/cloud/files', () => kind === 'provider auth'
      ? Response.json({ error: 'CLOUD_AUTH_FAILED' }, { status: 502 })
      : Response.json({ _embedded: { items: {} } }));
    component = runtime.mount(MainPage, { target }); runtime.flushSync();
    await vi.waitFor(() => { runtime.flushSync(); expect(target.querySelector('[role="alert"]')).not.toBeNull(); });
    expect(target.textContent).not.toContain('Offline Mode');
    expect(target.querySelector('a[data-source] h3')?.textContent).toBe(local.title);
  });
  it('keeps the filename address after caching a document with a different internal Card ID', async () => {
    const filename = 'Архив #1 ? заметка';
    remote = mockMarkdownReadHttp([{ file: makeReadFile({ name: `${filename}.md` }), source: v1 }]);
    const { cacheManager } = await import('../services/cacheManager');
    await cacheManager.validateCache();
    component = runtime.mount(MainPage, { target }); runtime.flushSync();
    await vi.waitFor(() => {
      runtime.flushSync();
      expect(target.querySelector('.status-bar')?.textContent).toContain('Loaded from');
    });
    const tiles = target.querySelectorAll<HTMLAnchorElement>('a[data-source]');
    expect(tiles).toHaveLength(1);
    expect(tiles[0].getAttribute('href')).toBe(`/card/${encodeURIComponent(filename)}`);
    expect(tiles[0].querySelector('h3')?.textContent).toBe('Карточка 🗂');
  });

  it.each([
    ['future version', futureV1Shape],
    ['unknown metadata', unknownMetadata]
  ])('retains the complete cached display instead of projecting a partial %s card', async (_, source) => {
    remote = mockMarkdownReadHttp([{ file: makeReadFile(), source }]);
    const write = vi.spyOn(db, 'saveCard');
    component = runtime.mount(MainPage, { target });
    runtime.flushSync();
    await vi.waitFor(() => {
      runtime.flushSync();
      expect(remote.downloads).toEqual([{ filename: 'test-card.md', source }]);
      expect(target.querySelector('.status-bar')?.textContent).toContain('Loaded from mixed');
    });

    const tile = target.querySelector<HTMLAnchorElement>('a[data-source][href="/card/test-card"]');
    expect(tile).toBeInstanceOf(HTMLAnchorElement);
    if (!tile) throw new Error('Expected the cached card on the board');
    expect(tile.querySelector('h3')?.textContent).toBe(local.title);
    expect(tile.querySelector('img')?.getAttribute('src')).toBe(local.image);
    expect(tile.closest('.kanban-column')?.querySelector('h2')?.textContent).toContain(local.status);
    expect(target.querySelectorAll('a[data-source]')).toHaveLength(1);
    expect(await db.getCard('test-card')).toEqual(storedCard(local));
    expect(write).not.toHaveBeenCalled();
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });
});
