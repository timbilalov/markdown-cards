import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { mockNewCardDocumentHttp } from './helpers/newCardDocumentHttp';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { NOW } from './helpers/fixtures';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store');
  return { page: readable({ params: { slug: 'existing-note' } }) };
});

let remote: ReturnType<typeof mockNewCardDocumentHttp>;
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];
let runtime: typeof import('svelte');
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  remote = mockNewCardDocumentHttp();
  remote.files.set('existing-note.md', v1);
  runtime = await import('svelte');
  cards = await import('../stores/cardStore');
  db = (await import('../services/dbService')).dbService;
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

it('shows a missing-document error after Save while keeping the visible draft intact', async () => {
  const draft = { ...structuredClone(v1Card), title: 'Visible unsaved edit' };
  cards.cardStore.set(draft);
  const Editor = (await import('../components/CombinedCardView.svelte')).default;
  component = runtime.mount(Editor, { target });
  runtime.flushSync();
  const button = [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.trim() === 'Save');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!button) throw new Error('Expected Save button');
  const before = structuredClone(draft);
  remote.http.fetch.mockClear();

  button.click();
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(get(cards.cardSaving)).toBe(false);
    expect(button.disabled).toBe(false);
  });

  const alert = target.querySelector('[role="alert"]');
  expect(alert, 'Save without a document must show a visible refusal').toBeInstanceOf(HTMLElement);
  expect(alert?.textContent)
    .toContain('Сохранение недоступно без контекста документа. Откройте заметку заново.');
  expect(target.querySelector<HTMLInputElement>('input[placeholder="Card title"]')?.value).toBe(before.title);
  expect(get(cards.cardStore)).toEqual(before);
  expect(get(cards.cardDocument)).toBeNull();
  expect(remote.files.get('existing-note.md')).toBe(v1);
  expect(remote.http.fetch).not.toHaveBeenCalled();
  expect(await db.getAllCards()).toEqual([]);
  expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
});
