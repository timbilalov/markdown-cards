import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MainPage from '../../routes/+page.svelte';
import { cloudFiles, syncFilesFromCloud, loadCardFromCloud } from '../stores/cloudStore';
import { initDB, loadLocalCards } from '../stores/dbStore';
import { makeCard, makeFile, NOW } from './helpers/fixtures';

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
  vi.mocked(loadCardFromCloud).mockResolvedValue(null);
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
    expect(target.querySelector('.status-bar')?.textContent).not.toContain('Loading...');
  });
}

function renderedCard(id: string) {
  const card = target.querySelector<HTMLAnchorElement>(`a[data-source][href="/card/${id}"]`);
  expect(card, `Rendered card ${id}`).not.toBeNull();
  return card!;
}

describe('Main page: actual component reconciliation', () => {
  it('does not claim an empty cloud folder or successful loading when the listing failed without local cards', async () => {
    vi.mocked(syncFilesFromCloud).mockRejectedValueOnce(new Error('Listing unavailable'));
    component = mount(MainPage, { target }); flushSync();
    await vi.waitFor(() => { flushSync(); expect(target.querySelector('[role="alert"]')).not.toBeNull(); });
    expect(target.textContent).not.toContain('No cards available in your cloud storage.');
    expect(target.querySelector('.is-success')).toBeNull();
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
      .mockResolvedValueOnce(makeCard({ title: 'Новое из облака' }))
      .mockResolvedValueOnce(makeCard({ title: 'Только в облаке', status: 'Done', meta: { ...local.meta, id: 'cloud-only' } }));

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

  it('shows filenames on a cold cloud-only load and ignores non-Markdown files', async () => {
    cloudFiles.set([makeFile(), makeFile({ name: 'ignore.txt' })]);
    await renderPage();
    expect(target.querySelectorAll('a[data-source]')).toHaveLength(1);
    expect(renderedCard('test-card').querySelector('h3')?.textContent).toBe('test-card');
    expect(renderedCard('test-card').dataset.source).toBe('cloud');
    expect(loadCardFromCloud).not.toHaveBeenCalled();
  });

  it('renders an empty folder without creating a card', async () => {
    await renderPage();
    expect(target.querySelectorAll('a[data-source]')).toHaveLength(0);
    expect(target.textContent).toContain('No cards available in your cloud storage.');
  });

  it('updates status together with title/image when the newer cloud card arrives', async () => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard({ status: 'В процессе' })]);
    cloudFiles.set([makeFile()]);
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(makeCard({ title: 'Готово', status: 'Done', image: 'https://example.invalid/new.png' }));
    await renderPage();
    const card = renderedCard('test-card');
    expect(card.querySelector('h3')?.textContent).toBe('Готово');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/new.png');
    expect(card.closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('Done');
  });

  it('clears old status and image when the newer cloud card omits them', async () => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard({ status: 'В процессе' })]);
    cloudFiles.set([makeFile()]);
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(makeCard({ title: 'Без статуса', status: undefined, image: undefined }));
    await renderPage();
    const card = renderedCard('test-card');
    expect(card.querySelector('h3')?.textContent).toBe('Без статуса');
    expect(card.querySelector('img')).toBeNull();
    expect(card.closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('Без статуса');
  });

  it('retains the full local display if loading the newer cloud content fails', async () => {
    vi.mocked(loadLocalCards).mockResolvedValue([makeCard()]);
    cloudFiles.set([makeFile()]);
    vi.mocked(loadCardFromCloud).mockResolvedValueOnce(null);
    await renderPage();
    const card = renderedCard('test-card');
    expect(card.querySelector('h3')?.textContent).toBe('Карточка 🗂');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/cover.png');
    expect(card.closest('.kanban-column')?.querySelector('h2')?.textContent).toContain('В процессе');
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
