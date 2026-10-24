import { historicalStorage } from './helpers/historicalStorage';
import { saveRepositoryPrototype } from './helpers/saveRepository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { get } from 'svelte/store';
import type { Card } from '../domain/types';
import { parseMarkdownDocument } from '../domain/markdown';
import { NOW, storedCard } from './helpers/fixtures';
import { mockNewCardDocumentHttp } from './helpers/newCardDocumentHttp';
import v1 from './fixtures/v1-card.md?raw';
import minimal from './fixtures/v1-minimal.md?raw';

const routeParams = vi.hoisted(() => ({ slug: 'new' }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store');
  return { page: readable({ params: routeParams }) };
});

let remote: ReturnType<typeof mockNewCardDocumentHttp>;
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];
let runtime: typeof import('svelte');
let CardPage: typeof import('../../routes/card/[slug]/+page.svelte')['default'];
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

beforeEach(async () => {
  vi.resetModules();
  // Keep Date fixed without advancing it when vi.waitFor polls.
  vi.setSystemTime(NOW);
  routeParams.slug = 'new';
  remote = mockNewCardDocumentHttp();
  runtime = await import('svelte');
  cards = await import('../stores/cardStore');
  db = (await import('../services/dbService')).dbService;
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  CardPage = (await import('../../routes/card/[slug]/+page.svelte')).default;
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.remove();
  remote.http.assertHandled();
});

function requireButton(label: RegExp) {
  const button = [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => label.test(button.textContent?.trim() ?? ''));
  expect(button, `Expected button ${label}`).toBeInstanceOf(HTMLButtonElement);
  if (!button) throw new Error('Expected a rendered button');
  return button;
}

function requireDraft() {
  const draft = get(cards.cardStore);
  expect(draft).not.toBeNull();
  if (!draft) throw new Error('Expected the editor draft');
  return draft;
}

async function openPage() {
  component = runtime.mount(CardPage, { target });
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(target.querySelector('input[placeholder="Card title"]')).toBeInstanceOf(HTMLInputElement);
    expect(get(cards.cardLoading)).toBe(false);
  });
}

async function saveThroughUI() {
  const button = requireButton(/^(Save|Сохранить)$/);
  expect(button.disabled).toBe(false);
  button.click();
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(get(cards.cardSaving)).toBe(false);
    expect(button.disabled).toBe(false);
  });
}

function readFixture(source: string): Card {
  const parsed = parseMarkdownDocument(source);
  expect(parsed.status).toBe('success');
  if (parsed.status !== 'success') throw new Error('Expected a valid fixture');
  return parsed.document.card;
}

function expectedMinimal(id: string, title = 'New Card') {
  return minimal.replace('# Минимальная карточка', `# ${title}`).replace('\nminimal-card\n', `\n${id}\n`)
    .replace('2026-09-01T00:00:00.000Z', new Date(NOW).toISOString())
    .replace('2026-09-24T00:00:00.000Z', new Date(NOW).toISOString());
}

describe('new note: v1 creation through the actual editor page', () => {
  it('creates v1 without overwriting a file, then updates that same file on the next explicit Save', async () => {
    await openPage();
    const id = requireDraft().meta.id;
    await saveThroughUI();

    expect(remote.uploads).toEqual([{ path: `${id}.md`, content: expectedMinimal(id), overwrite: 'false' }]);
    expect(target.querySelector('[role="status"]')?.textContent).toEqual(expect.stringMatching(/сохранено.*Яндекс Диск/i));
    cards.cardStore.update(card => card && { ...card, title: 'Вторая редакция' });
    runtime.flushSync();
    await saveThroughUI();
    expect(remote.uploads[1]).toEqual({ path: `${id}.md`, content: expectedMinimal(id, 'Вторая редакция'), overwrite: 'true' });
    expect(await db.getCard(id)).toEqual(storedCard(readFixture(expectedMinimal(id, 'Вторая редакция'))));
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('saves all fields and an empty ordered section, then reopens the new remote document without migration', async () => {
    await openPage();
    const initial = requireDraft();
    const expected = v1.replace('\ntest-card\n', `\n${initial.meta.id}\n`)
      .replace('2026-09-01T08:09:10.123Z', new Date(NOW).toISOString());
    const complete = { ...readFixture(v1), meta: { ...initial.meta } };
    cards.cardStore.set(complete);
    runtime.flushSync();
    await saveThroughUI();

    expect(remote.uploads).toEqual([{ path: `${initial.meta.id}.md`, content: expected, overwrite: 'false' }]);
    expect(await db.getCard(initial.meta.id)).toEqual(storedCard(complete));
    if (component) await runtime.unmount(component);
    component = undefined;
    target.replaceChildren();
    routeParams.slug = initial.meta.id;
    await openPage();
    expect(get(cards.cardStore)).toEqual(complete);
    expect(target.textContent).not.toContain('Обновить формат');
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(false);
  });

  it('local snapshot: uses one save timestamp and one local snapshot even when persistence advances the clock', async () => {
    await openPage();
    const draft = requireDraft();
    const writes: string[] = [];
    const prototype = await saveRepositoryPrototype();
    const persist = prototype.save;
    vi.spyOn(await saveRepositoryPrototype(), 'save').mockImplementation(async function (this: Awaited<ReturnType<typeof saveRepositoryPrototype>>, snapshot) {
      writes.push(snapshot.document.source);
      const result = await persist.call(this, snapshot);
      vi.setSystemTime(NOW + 1234);
      return result;
    });
    await saveThroughUI();

    const expected = readFixture(expectedMinimal(draft.meta.id));
    expect(writes).toEqual([expectedMinimal(draft.meta.id)]);
    expect(remote.uploads[0]?.content).toBe(expectedMinimal(draft.meta.id));
    expect(await db.getCard(draft.meta.id)).toEqual(storedCard(expected));
    expect(get(cards.cardStore)).toEqual(expected);
  });
});

const invalidEdits: [string, (card: Card) => Card][] = [
  ['empty title', card => ({ ...card, title: '' })],
  ['empty ID', card => ({ ...card, meta: { ...card.meta, id: '' } })],
  ['path traversal ID', card => ({ ...card, meta: { ...card.meta, id: '../outside' } })],
  ['reserved ID', card => ({ ...card, meta: { ...card.meta, id: 'new' } })],
  ['replacement ID', card => ({ ...card, meta: { ...card.meta, id: 'other-safe-id' } })],
  ['unrepresentable description', card => ({ ...card, description: '# KEEP-THIS-HEADING' })],
  ['invalid creation timestamp', card => ({ ...card, meta: { ...card.meta, created: NaN } })],
  ['unknown metadata', card => ({ ...card, meta: { ...card.meta, custom: 'KEEP-THIS-VALUE' } })]
];

describe('new note: refuse lossy or invalid saves before any write', () => {
  it.each(invalidEdits)('retains a draft with %s and shows a save error', async (_, edit) => {
    await openPage();
    const edited = edit(requireDraft());
    cards.cardStore.set(edited);
    runtime.flushSync();
    const write = vi.spyOn(db, 'saveCard');
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');

    await saveThroughUI();

    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    expect(get(cards.cardSaveError)).toEqual(expect.any(String));
    expect(get(cards.cardStore)).toEqual(edited);
    expect(write).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([]);
  });

  it('shows a format refusal in Markdown preview for an unrepresentable new draft', async () => {
    await openPage();
    const edited = { ...requireDraft(), description: '# KEEP-THIS-HEADING' };
    cards.cardStore.set(edited);
    runtime.flushSync();
    requireButton(/^Switch to Markdown View$/).click();
    runtime.flushSync();

    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    expect(get(cards.cardStore)).toEqual(edited);
    expect(remote.uploads).toEqual([]);
  });
});

describe('new note: failed saves remain explicit and retryable', () => {
  it.each([503, 'network'] as const)('keeps unknown %s upload outcome blocked even on another Save', async failure => {
    await openPage();
    const draft = structuredClone(requireDraft());
    remote.setFailure(failure);
    await saveThroughUI();

    expect(target.querySelector('[role="alert"]')?.textContent).toEqual(expect.stringMatching(/неизвестен/i));
    expect(get(cards.cardSaveError)).toEqual(expect.any(String));
    expect(get(cards.cardStore)).toEqual(draft);
    expect(remote.files.size).toBe(0);
    expect(remote.uploads).toEqual([{ path: `${draft.meta.id}.md`, content: expectedMinimal(draft.meta.id), overwrite: 'false' }]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
    expect(await db.getCard(draft.meta.id)).toMatchObject(readFixture(expectedMinimal(draft.meta.id)));
    remote.setFailure(null);
    await saveThroughUI();
    expect(remote.uploads).toHaveLength(1);
    expect(remote.files.has(`${draft.meta.id}.md`)).toBe(false);
    expect(get(cards.cardSaveError)).toMatch(/неизвестен/i);
  });

  it('does not overwrite an existing remote file on a new-document name collision', async () => {
    await openPage();
    const draft = structuredClone(requireDraft());
    remote.files.set(`${draft.meta.id}.md`, 'KEEP-THE-OTHER-DOCUMENT');
    remote.http.on('GET', `/api/cloud/download?path=${draft.meta.id}.md`, () => new Response('KEEP-THE-OTHER-DOCUMENT'));
    await saveThroughUI();

    expect(remote.files.get(`${draft.meta.id}.md`)).toBe('KEEP-THE-OTHER-DOCUMENT');
    expect(remote.uploads).toEqual([]);
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    expect(get(cards.cardStore)).toEqual(draft);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('local snapshot: reports a local write failure without a second local attempt or an upload', async () => {
    await openPage();
    const draft = structuredClone(requireDraft());
    const write = vi.spyOn(await saveRepositoryPrototype(), 'save').mockRejectedValue(new Error('quota exceeded'));
    await saveThroughUI();

    expect(write).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    expect(get(cards.cardSaveError)).toEqual(expect.any(String));
    expect(get(cards.cardStore)).toEqual(draft);
    expect(remote.uploads).toEqual([]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });
});
