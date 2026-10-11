import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { get } from 'svelte/store';
import { mockCardDocumentHttp, documentSlug } from './helpers/cardDocumentHttp';
import { v1 } from './helpers/markdownReadFixtures';
import { NOW } from './helpers/fixtures';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store');
  return { page: readable({ params: { slug: 'existing-note' } }) };
});

let remote: ReturnType<typeof mockCardDocumentHttp>;
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];
let runtime: typeof import('svelte');
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  remote = mockCardDocumentHttp(v1);
  runtime = await import('svelte');
  cards = await import('../stores/cardStore');
  db = (await import('../services/dbService')).dbService;
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.remove();
  remote.http.assertHandled();
});

it('the actual page refuses preview when only a bare draft remains, preserving the draft and cached source', async () => {
  const CardPage = (await import('../../routes/card/[slug]/+page.svelte')).default;
  component = runtime.mount(CardPage, { target });
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(get(cards.cardLoading)).toBe(false);
    expect(get(cards.cardDocument)?.status).toBe('loaded');
    expect(target.querySelector('input[placeholder="Card title"]')).toBeInstanceOf(HTMLInputElement);
  });
  const button = [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.trim() === 'Switch to Markdown View');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!button) throw new Error('Expected preview toggle');
  button.click();
  runtime.flushSync();
  expect(target.querySelector('h1')?.textContent).toBe('Карточка 🗂');
  const draft = structuredClone(get(cards.cardStore));
  expect(draft).not.toBeNull();
  const storedSource = await db.getMarkdownDocument(documentSlug);
  const storedCards = await db.getAllCards();
  remote.http.fetch.mockClear();

  // Public APIs leave a bare Card without declaring its source format. The
  // mounted page must propagate the lost context to its preview component.
  cards.resetCardDocument();
  cards.cardStore.set(draft);
  runtime.flushSync();

  expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
    'Формат заметки не определён. Откройте её заново.');
  expect(target.querySelector('h1, h2, h3, ul, ol, img')).toBeNull();
  expect(get(cards.cardStore)).toEqual(draft);
  expect(get(cards.cardDocument)).toBeNull();
  expect(await db.getMarkdownDocument(documentSlug)).toEqual(storedSource);
  expect(await db.getAllCards()).toEqual(storedCards);
  expect(await db.getLocalMarkdownSnapshot(documentSlug)).toBeNull();
  expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  expect(remote.readRemoteSource()).toBe(v1);
  expect(remote.uploads).toEqual([]);
  expect(remote.http.fetch).not.toHaveBeenCalled();
});
