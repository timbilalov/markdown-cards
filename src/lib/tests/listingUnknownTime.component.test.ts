import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCard, NOW, storedCard } from './helpers/fixtures';
import { mockHttp } from './helpers/http';
import { v1, v1Card } from './helpers/markdownReadFixtures';

vi.mock('$app/environment', () => ({ browser: true }));

let http: ReturnType<typeof mockHttp>;
let db: typeof import('../services/dbService')['dbService'];
let runtime: typeof import('svelte');
let MainPage: typeof import('../../routes/+page.svelte')['default'];
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;
const local = makeCard({ title: 'Локальная карточка', status: 'Предстоящие' });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  http = mockHttp({ authenticated: true });
  // The route's compatible DTO deliberately omits modified and size.
  http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [
    { name: 'test-card.md', path: 'test-card.md' }
  ] } }));
  runtime = await import('svelte');
  db = (await import('../services/dbService')).dbService;
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  MainPage = (await import('../../routes/+page.svelte')).default;
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.remove();
  http.assertHandled();
});

async function renderPage(source: 'cloud' | 'mixed' = 'cloud') {
  component = runtime.mount(MainPage, { target });
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(target.querySelector('.status-bar')?.textContent).toContain(`Loaded from ${source} `);
  });
}

function tile() {
  const element = target.querySelector('a[data-source][href="/card/test-card"]');
  expect(element).not.toBeNull();
  return element!;
}

function downloads() {
  return http.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/cloud/download'));
}

describe('board: listed files with an unknown remote modification time', () => {
  it('shows an explicit unknown date on a cold load without guessing a date or downloading each note', async () => {
    await renderPage();
    expect(tile().querySelector('.modified-date')?.textContent).toContain('Дата изменения неизвестна');
    expect(tile().querySelector('h3')?.textContent).toBe('test-card');
    expect(target.textContent).not.toContain('Invalid Date');
    expect(downloads()).toEqual([]);
    expect(await db.getAllCards()).toEqual([]);
  });

  it('refreshes a cached card with unknown remote time and shows the downloaded document date', async () => {
    await db.saveCard(local);
    http.on('GET', '/api/cloud/download?path=test-card.md', () => new Response(v1));
    await renderPage('mixed');

    expect(downloads()).toEqual([['/api/cloud/download?path=test-card.md', { method: 'GET', signal: expect.any(AbortSignal) }]]);
    expect(tile().querySelector('h3')?.textContent).toBe(v1Card.title);
    expect(tile().querySelector('.modified-date')?.textContent).toContain(new Date(v1Card.meta.modified).toLocaleDateString());
    expect(await db.getCard('test-card')).toEqual(storedCard(v1Card));
    expect(await db.getMarkdownDocument('test-card')).toMatchObject({
      result: { status: 'success', document: { source: v1 } }
    });
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('attempts the unknown-time refresh but retains the full cached display on a refused download', async () => {
    await db.saveCard(local);
    http.on('GET', '/api/cloud/download?path=test-card.md', () => new Response(null, { status: 401 }));
    await renderPage('mixed');

    expect(downloads()).toEqual([['/api/cloud/download?path=test-card.md', { method: 'GET', signal: expect.any(AbortSignal) }]]);
    expect(tile().querySelector('h3')?.textContent).toBe(local.title);
    expect(tile().querySelector('.modified-date')?.textContent).toContain(new Date(local.meta.modified).toLocaleDateString());
    expect(tile().querySelector('img')?.getAttribute('src')).toBe(local.image);
    expect(tile().closest('.kanban-column')?.querySelector('h2')?.textContent).toContain(local.status);
    expect(await db.getCard('test-card')).toEqual(storedCard(local));
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('uses the document date when warming an unknown-time cloud-only card alongside a local card', async () => {
    await db.saveCard(makeCard({ meta: { ...local.meta, id: 'local-only' } }));
    http.on('GET', '/api/cloud/download?path=test-card.md', () => new Response(v1));
    await renderPage('mixed');

    expect(tile().querySelector('.modified-date')?.textContent).toContain(new Date(v1Card.meta.modified).toLocaleDateString());
    expect(tile().querySelector('h3')?.textContent).toBe(v1Card.title);
    expect(downloads()).toEqual([['/api/cloud/download?path=test-card.md', { method: 'GET', signal: expect.any(AbortSignal) }]]);
    expect(target.querySelectorAll('a[data-source]')).toHaveLength(2);
  });
});
