import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

let remote: ReturnType<typeof mockCardDocumentHttp> | undefined;
let runtime: typeof import('svelte');
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  runtime = await import('svelte');
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.remove();
  remote?.http.assertHandled();
  remote = undefined;
});

describe('Downloaded v1 source → actual card page → safe preview', () => {
  it.each([
    ['link', v1.replace('[ссылка](https://example.invalid)', '[ссылка](java&#9;script:void%200)'), 'a[href]'],
    ['cover', v1.replace('https://example.invalid/cover.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), 'img[src]']
  ])('neutralizes the %s only in the view, preserving the downloaded document', async (_name, source, unsafeSelector) => {
    remote = mockCardDocumentHttp(source);
    const cards = await import('../stores/cardStore');
    const db = (await import('../services/dbService')).dbService;
    setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
    await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
    const CardPage = (await import('../../routes/card/[slug]/+page.svelte')).default;
    component = runtime.mount(CardPage, { target });
    runtime.flushSync();
    await vi.waitFor(() => {
      runtime.flushSync();
      expect(get(cards.cardLoading)).toBe(false);
      expect(get(cards.cardDocument)?.status).toBe('loaded');
      expect(target.querySelector('input[placeholder="Card title"]')).toBeInstanceOf(HTMLInputElement);
    });

    const before = structuredClone(get(cards.cardStore));
    const documentBefore = structuredClone(get(cards.cardDocument));
    const cachedSource = await db.getMarkdownDocument(documentSlug);
    const cachedCards = await db.getAllCards();
    expect(cachedSource?.result).toMatchObject({ status: 'success', document: { source } });
    const button = [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find(candidate => candidate.textContent?.trim() === 'Switch to Markdown View');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!button) throw new Error('Expected preview toggle');
    remote.http.fetch.mockClear();

    button.click();
    runtime.flushSync();
    expect(target.querySelector('h1')?.textContent).toBe('Карточка 🗂');
    expect(target.textContent).toContain('Второй абзац');
    expect(get(cards.cardStore)).toEqual(before);
    expect(get(cards.cardDocument)).toEqual(documentBefore);
    expect(await db.getMarkdownDocument(documentSlug)).toEqual(cachedSource);
    expect(await db.getAllCards()).toEqual(cachedCards);
    expect(await db.getLocalMarkdownSnapshot(documentSlug)).toBeNull();
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
    expect(remote.readRemoteSource()).toBe(source);
    expect(remote.uploads).toEqual([]);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(target.querySelector(`.content ${unsafeSelector}`)).toBeNull();
  });
});
