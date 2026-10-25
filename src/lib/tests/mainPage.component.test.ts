import type { BoardCardLoadResult } from '../application/loadBoard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MainPage from '../../routes/+page.svelte';
import { cloudFiles, syncFilesFromCloud, loadCardFromCloud } from '../stores/cloudStore';
import { initDB, loadLocalCards } from '../stores/dbStore';
import { boardReadResult, makeCard, makeFile, NOW } from './helpers/fixtures';

vi.mock('../services/storageSession',()=>({initializeStorageSession:async()=>({verified:true}),getStorageSession:()=>null}));
vi.mock('../stores/cloudStore', async () => {
  const { writable } = await import('svelte/store');
  return {
    cloudFiles: writable([]), isAuthenticated: writable(true), syncStatus: writable({ isSyncing: false, lastSync: null, error: null }),
    syncFilesFromCloud: vi.fn(), loadCardFromCloud: vi.fn(), checkIsSessionAuthenticated: vi.fn(async () => true)
  };
});
vi.mock('../stores/dbStore', async () => {
  const { readable } = await import('svelte/store');
  return { dbInitialized: readable(true), initDB: vi.fn(), loadLocalCards: vi.fn() };
});
vi.mock('../services/cacheManager', () => ({ cacheManager: { validateCache: vi.fn() } }));

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.mocked(initDB).mockResolvedValue(undefined);
  vi.mocked(loadLocalCards).mockResolvedValue([]);
  vi.mocked(syncFilesFromCloud).mockResolvedValue(undefined);
  vi.mocked(loadCardFromCloud).mockResolvedValue(boardReadResult(null));
  vi.clearAllMocks();
  cloudFiles.set([]);
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
});

async function renderPage() {
  component = mount(MainPage, { target });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('.board-progress')).toBeNull();
  });
}

function renderedCard(id: string) {
  const card = target.querySelector<HTMLAnchorElement>(`a[data-source][href="/card/${id}"]`);
  expect(card, `Rendered card ${id}`).not.toBeNull();
  return card!;
}

describe('Main page: actual component reconciliation', () => {
  it('manually reloads all cloud notes, including current cached notes, and disables duplicate refreshes', async () => {
    const current = makeCard({ meta: { id: 'test-card', created: NOW, modified: NOW } });
    vi.mocked(loadLocalCards).mockResolvedValue([current]);
    cloudFiles.set([makeFile()]);
    await renderPage();
    expect(loadCardFromCloud).not.toHaveBeenCalled();
    const response = Promise.withResolvers<BoardCardLoadResult>();
    vi.mocked(loadCardFromCloud).mockImplementationOnce(() => response.promise);
    const refresh = target.querySelector<HTMLButtonElement>('button[aria-label="Обновить все заметки из облака"]')!;
    refresh.click(); flushSync();
    expect(refresh.disabled).toBe(true);
    refresh.click();
    await vi.waitFor(() => expect(loadCardFromCloud).toHaveBeenCalledTimes(1));
    response.resolve(boardReadResult(makeCard({ title: 'Manual refresh' })));
    await vi.waitFor(() => { flushSync(); expect(refresh.disabled).toBe(false); });
    expect(renderedCard('test-card').querySelector('h3')?.textContent).toBe('Manual refresh');
    expect(loadCardFromCloud).toHaveBeenCalledWith(makeFile(), expect.any(AbortSignal), true);
    expect(syncFilesFromCloud).toHaveBeenCalledTimes(2);
  });

  it('automatically refreshes at ten minutes while visible and cleans up on unmount', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    await renderPage();
    expect(syncFilesFromCloud).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(syncFilesFromCloud).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    flushSync();
    expect(syncFilesFromCloud).toHaveBeenCalledTimes(2);
    await unmount(component!); component = undefined;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(syncFilesFromCloud).toHaveBeenCalledTimes(2);
  });

  it('waits while the tab is hidden and checks for updates when it becomes visible', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await renderPage();
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(syncFilesFromCloud).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(syncFilesFromCloud).toHaveBeenCalledTimes(2));
  });

  it('does not claim an empty cloud folder or successful loading when the listing failed without local cards', async () => {
    vi.mocked(syncFilesFromCloud).mockRejectedValueOnce(new Error('Listing unavailable'));
    component = mount(MainPage, { target }); flushSync();
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('[role="alert"]')).not.toBeNull(); });
    expect(target.textContent).not.toContain('No cards available in your cloud storage.');
    expect(target.querySelector('.is-success')).toBeNull();
    expect(target.querySelector('.card-loading')).toBeNull();
    expect(target.textContent).toContain('Список заметок недоступен');
  });

  it('links an existing new.md to the file editor instead of the new-note action', async () => {
    cloudFiles.set([makeFile({ name: 'new.md' })]);
    await renderPage();
    expect(target.querySelector('a[data-source]')?.getAttribute('href')).toBe('/card/new?mode=edit');
  });
  it('renders cloud-newer, local-only and cloud-only cards without duplicate ids', async () => {
    const local = makeCard();
    const localOnly = makeCard({ title: 'Только локально', meta: { ...local.meta, id: 'local-only' } });
    vi.mocked(loadLocalCards).mockResolvedValue([local, localOnly]);
    const cloudOnly = makeFile({ name: 'cloud-only.md' });
    cloudFiles.set([makeFile(), cloudOnly, makeFile({ name: 'ignore.txt' })]);
    vi.mocked(loadCardFromCloud)
      .mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Новое из облака' })))
      .mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Только в облаке', status: 'Done', meta: { ...local.meta, id: 'cloud-only' } })));

    await renderPage();

    expect(target.querySelectorAll('a[data-source]')).toHaveLength(3);
    expect(renderedCard('test-card').dataset.source).toBe('mixed');
    expect(renderedCard('test-card').querySelector('h3')?.textContent).toBe('Новое из облака');
    expect(renderedCard('test-card').querySelector('.fa-refresh')).not.toBeNull();
    expect(renderedCard('local-only').dataset.source).toBe('indexeddb');
    expect(renderedCard('local-only').querySelector('h3')?.textContent).toBe('Только локально');
    expect(renderedCard('cloud-only').dataset.source).toBe('cloud');
    expect(renderedCard('cloud-only').querySelector('h3')?.textContent).toBe('Только в облаке');
    expect(renderedCard('cloud-only').closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('Done');
    expect(loadCardFromCloud).toHaveBeenCalledTimes(2);
    expect(target.querySelector('.status-bar')?.textContent).toContain('Loaded from mixed');
  });

  it.each([0, 1])('keeps the local version when its timestamp is equal or %i ms newer', async (delta) => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard({ meta: { id: 'test-card', created: NOW, modified: NOW + delta } })]);
    cloudFiles.set([makeFile()]);
    await renderPage();
    expect(renderedCard('test-card').dataset.source).toBe('indexeddb');
    expect(loadCardFromCloud).not.toHaveBeenCalled();
  });

  it('keeps cached cards visible when cloud synchronization rejects', async () => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard()]);
    vi.mocked(syncFilesFromCloud).mockRejectedValueOnce(new TypeError('offline'));
    await renderPage();
    expect(renderedCard('test-card').querySelector('h3')?.textContent).toBe('Карточка 🗂');
    expect(target.querySelector('.status-bar')?.textContent).toContain('Offline Mode');
  });

  it('loads titles, statuses and images on a cold cloud-only load and ignores non-Markdown files', async () => {
    cloudFiles.set([makeFile(), makeFile({ name: 'ignore.txt' })]);
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Из облака', status: 'Done' })));
    await renderPage();
    expect(target.querySelectorAll('a[data-source]')).toHaveLength(1);
    expect(renderedCard('test-card').querySelector('h3')?.textContent).toBe('Из облака');
    expect(renderedCard('test-card').querySelector('img')?.getAttribute('src')).toBe(makeCard().image);
    expect(renderedCard('test-card').closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('Done');
    expect(renderedCard('test-card').dataset.source).toBe('cloud');
    expect(loadCardFromCloud).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached board usable during listing and shows progress as individual notes arrive', async () => {
    let releaseListing!: () => void;
    let releaseFirst!: (result: BoardCardLoadResult) => void;
    let releaseSecond!: (result: BoardCardLoadResult) => void;
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard(), makeCard({ meta: { ...makeCard().meta, id: 'local-only' } })]);
    vi.mocked(syncFilesFromCloud).mockImplementationOnce(() => new Promise(resolve => { releaseListing = resolve; }));
    cloudFiles.set([makeFile(), makeFile({ name: 'other.md' })]);
    vi.mocked(loadCardFromCloud)
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseSecond = resolve; }));
    component = mount(MainPage, { target }); flushSync();
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('a[data-source] h3')?.textContent).toBe('Карточка 🗂'); });
    expect(target.querySelector('.board-progress[role="status"]')).not.toBeNull();
    expect(target.querySelector('.loading')).toBeNull();
    expect(target.querySelector('.is-success')).toBeNull();
    expect(renderedCard('test-card').getAttribute('href')).toBe('/card/test-card');
    expect(target.querySelector('a[href="/card/new"]')).not.toBeNull();
    releaseListing();
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('progress')?.value).toBe(0); });
    expect(target.querySelector('progress')?.max).toBe(2);
    expect(renderedCard('test-card').getAttribute('aria-busy')).toBe('true');
    expect(renderedCard('test-card').querySelector('.card-loading[aria-label="Загрузка из облака"]')).not.toBeNull();
    expect(renderedCard('other').querySelector('.card-loading')).not.toBeNull();
    expect(renderedCard('other').getAttribute('aria-busy')).toBe('true');
    expect(renderedCard('local-only').querySelector('.card-loading')).toBeNull();
    expect(renderedCard('local-only').getAttribute('aria-busy')).toBe('false');
    expect(target.querySelectorAll('.card-loading')).toHaveLength(2);
    releaseFirst(boardReadResult(makeCard({ title: 'Обновлено', status: 'Done' })));
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('progress')?.value).toBe(1); });
    expect(renderedCard('test-card').querySelector('h3')?.textContent).toBe('Обновлено');
    expect(renderedCard('test-card').closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('Done');
    expect(renderedCard('test-card').getAttribute('aria-busy')).toBe('false');
    expect(renderedCard('test-card').querySelector('.card-loading')).toBeNull();
    expect(renderedCard('other').getAttribute('aria-busy')).toBe('true');
    expect(renderedCard('other').querySelector('.card-loading')).not.toBeNull();
    releaseSecond(boardReadResult(makeCard({ title: 'Вторая' })));
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('.board-progress')).toBeNull(); });
    expect(renderedCard('other').querySelector('h3')?.textContent).toBe('Вторая');
    expect(target.querySelector('.card-loading')).toBeNull();
    expect(target.querySelector('a[aria-busy="true"]')).toBeNull();
  });

  it('keeps newest notes first when cloud listing order and provider dates differ', async () => {
    let releaseListing!: () => void;
    const base = makeCard();
    const locals = ['a-note', 'z-note'].map((id, index) => makeCard({ meta: { ...base.meta, id, modified: NOW + index } }));
    vi.mocked(loadLocalCards).mockResolvedValue(locals);
    cloudFiles.set(['a-note', 'z-note'].map(id => makeFile({ name: `${id}.md`, modified: new Date(NOW + 100).toISOString() })));
    vi.mocked(syncFilesFromCloud).mockImplementationOnce(() => new Promise(resolve => { releaseListing = resolve; }));
    vi.mocked(loadCardFromCloud).mockImplementation(async file => boardReadResult(locals.find(card => `${card.meta.id}.md` === file.name)!));
    component = mount(MainPage, { target }); flushSync();
    const order = () => [...target.querySelectorAll('a[data-source]')].map(card => card.getAttribute('href'));
    await vi.waitFor(() => { flushSync(); expect(order()).toHaveLength(2); });
    const before = order();
    expect(before).toEqual(['/card/z-note', '/card/a-note']);
    releaseListing();
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('.board-progress')).toBeNull(); });
    expect(order()).toEqual(before);
  });

  it('renders an empty folder without creating a card', async () => {
    await renderPage();
    expect(target.querySelectorAll('a[data-source]')).toHaveLength(0);
    expect(target.textContent).toContain('No cards available in your cloud storage.');
  });

  it('updates status together with title/image when the newer cloud card arrives', async () => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard({ status: 'В процессе' })]);
    cloudFiles.set([makeFile()]);
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Готово', status: 'Done', image: 'https://example.invalid/new.png' })));
    await renderPage();
    const card = renderedCard('test-card');
    expect(card.querySelector('h3')?.textContent).toBe('Готово');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/new.png');
    expect(card.closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('Done');
  });

  it('clears old status and image when the newer cloud card omits them', async () => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard({ status: 'В процессе' })]);
    cloudFiles.set([makeFile()]);
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Без статуса', status: undefined, image: undefined })));
    await renderPage();
    const card = renderedCard('test-card');
    expect(card.querySelector('h3')?.textContent).toBe('Без статуса');
    expect(card.querySelector('img')).toBeNull();
    expect(card.closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('Без статуса');
  });

  it('retains the full local display if loading the newer cloud content fails', async () => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard()]);
    cloudFiles.set([makeFile()]);
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(boardReadResult(null));
    await renderPage();
    const card = renderedCard('test-card');
    expect(card.querySelector('h3')?.textContent).toBe('Карточка 🗂');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/cover.png');
    expect(card.closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('В процессе');
    expect(card.parentElement?.querySelector('.card-load-error')).not.toBeNull();
  });

  it.each([true, false])('retries a failed note without navigating or reloading other notes (success=%s)', async succeeds => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard()]);
    cloudFiles.set([makeFile(), makeFile({ name: 'healthy.md' })]);
    const response = Promise.withResolvers<BoardCardLoadResult>();
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(boardReadResult(null)).mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Healthy' })))
      .mockImplementationOnce(() => response.promise);
    await renderPage();
    const retry = target.querySelector<HTMLButtonElement>('.card-load-error')!;
    expect(retry).not.toBeNull();
    expect(retry.closest('a')).toBeNull();
    expect(retry.getAttribute('aria-label')).toContain('Повторить загрузку заметки');
    const location = window.location.href;
    retry.click(); flushSync();
    expect(target.querySelector('.card-load-error')).toBeNull();
    expect(renderedCard('test-card').querySelector('.card-loading')).not.toBeNull();
    expect(renderedCard('healthy').querySelector('.card-loading')).toBeNull();
    response.resolve(boardReadResult(succeeds ? makeCard({ title: 'Retried', status: 'Done' }) : null));
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('.card-loading')).toBeNull(); });
    expect(target.querySelectorAll('.card-load-error')).toHaveLength(succeeds ? 0 : 1);
    expect(renderedCard('test-card').querySelector('h3')?.textContent).toBe(succeeds ? 'Retried' : 'Карточка 🗂');
    expect(renderedCard('healthy').querySelector('h3')?.textContent).toBe('Healthy');
    expect(window.location.href).toBe(location);
    expect(loadCardFromCloud).toHaveBeenCalledTimes(3);
    expect(loadCardFromCloud).toHaveBeenLastCalledWith(makeFile(), expect.any(AbortSignal), true);
    expect(syncFilesFromCloud).toHaveBeenCalledTimes(1);
  });
});

it('shows the initialization error and stops loading when local storage is unavailable', async () => {
  vi.mocked(initDB).mockRejectedValueOnce(new Error('blocked upgrade'));
  component = mount(MainPage, { target }); flushSync();
  await vi.waitFor(() => { flushSync(); expect(target.querySelector('.loading')).toBeNull(); });
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('blocked upgrade');
  expect(target.querySelector('.loading')).toBeNull();
  expect(syncFilesFromCloud).not.toHaveBeenCalled();
});
