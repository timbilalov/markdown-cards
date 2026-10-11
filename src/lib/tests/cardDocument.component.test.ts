import { saveRepositoryPrototype } from './helpers/saveRepository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { get } from 'svelte/store';
import { parseMarkdownDocument } from '../domain/markdown';
import { mockCardDocumentHttp } from './helpers/cardDocumentHttp';
import { NOW } from './helpers/fixtures';
import legacy from './fixtures/migration-legacy.md?raw';
import migrated from './fixtures/migration-v1.md?raw';
import legacyWithAlt from './fixtures/legacy-card.md?raw';
import v1 from './fixtures/v1-card.md?raw';
import future from './fixtures/unsupported-version.md?raw';
import unknownMetadata from './fixtures/v1-unsupported-metadata.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store');
  return { page: readable({ params: { slug: 'existing-note' } }) };
});

let remote: ReturnType<typeof mockCardDocumentHttp>;
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];
let runtime: typeof import('svelte');
let CardPage: typeof import('../../routes/card/[slug]/+page.svelte')['default'];
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

it('saves removal of optional status and image through the real editor inputs', async () => {
  remote = mockCardDocumentHttp(v1);
  component = runtime.mount(CardPage, { target }); runtime.flushSync();
  await vi.waitFor(() => { runtime.flushSync(); expect(target.querySelector('input[aria-label="Статус"]')).not.toBeNull(); });
  for (const selector of ['input[aria-label="Статус"]', 'input#image']) {
    const input = target.querySelector<HTMLInputElement>(selector)!;
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  runtime.flushSync();
  const save = [...target.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Save')!;
  save.click();
  await vi.waitFor(() => { runtime.flushSync(); expect(remote.uploads).toHaveLength(1); });
  expect(remote.uploads[0].content).not.toContain('- **Status:**');
  expect(remote.uploads[0].content).not.toContain('![](');
  expect(get(cards.cardSaveError)).toBeNull();
});

beforeEach(async () => {
  vi.resetModules();
  // Freeze Date without fake timers: vi.waitFor advances an installed fake
  // clock while polling, which must not change the expected save timestamp.
  vi.setSystemTime(NOW);
  remote = mockCardDocumentHttp(legacy);
  runtime = await import('svelte');
  cards = await import('../stores/cardStore');
  db = (await import('../services/dbService')).dbService;
  const service = (await import('../services/cloudService')).cloudService;
  setLegacyClientToken(service, 'test-only-token');
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

async function openPage() {
  component = runtime.mount(CardPage, { target });
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(remote.downloads.length).toBeGreaterThan(0);
    expect(get(cards.cardLoading)).toBe(false);
    expect(target.querySelector('.loading')).toBeNull();
  });
}

async function reopenPage() {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.replaceChildren();
  remote.advanceRemoteModifiedTime();
  await openPage();
}

function findButton(label: RegExp) {
  return [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => label.test(button.textContent?.trim() ?? ''));
}

function requireButton(label: RegExp) {
  const button = findButton(label);
  expect(button, `Expected button ${label}`).toBeInstanceOf(HTMLButtonElement);
  if (!button) throw new Error('Expected a rendered button');
  return button;
}

function requireSource() {
  const source = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Исходный Markdown"]');
  expect(source, 'Original source available without an editable partial card').toBeInstanceOf(HTMLTextAreaElement);
  if (!source) throw new Error('Expected the original Markdown');
  expect(source.readOnly).toBe(true);
  return source;
}

async function clickMigration() {
  const button = requireButton(/^Обновить формат$/);
  expect(button.disabled).toBe(false);
  button.click();
  runtime.flushSync();
  await runtime.tick();
}

async function clickSave() {
  const button = requireButton(/^(Save|Сохранить)$/);
  expect(button.disabled).toBe(false);
  button.click();
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(remote.uploads).toHaveLength(1);
    expect(get(cards.cardSaving)).toBe(false);
  });
  await db.getCard('test-card');
}

describe('existing note: explicit format update in the actual editor page', () => {
  it('opens remote legacy with its original source, an update button and disabled Save', async () => {
    await openPage();
    expect(requireButton(/^Обновить формат$/).disabled).toBe(false);
    expect(requireSource().value).toBe(legacy);
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(true);
    expect(target.querySelector('input[placeholder="Card title"]')).toBeNull();
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(legacy);
  });

  it('hides the update button immediately after migration and enables editing without a write', async () => {
    await openPage();
    const write = vi.spyOn(db, 'saveCard');
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');
    await clickMigration();

    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(false);
    expect(target.querySelector<HTMLInputElement>('input[placeholder="Card title"]')?.value).toBe('Карточка 🗂');
    expect(get(cards.cardStore)?.meta).toMatchObject({
      id: 'test-card', created: Date.parse('2026-09-01T00:00:00.000Z'), modified: Date.parse('2026-09-24T00:00:00.000Z')
    });
    expect(write).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(legacy);
  });

  it('uses the existing Save button to update the same remote file, and reopens it without migration', async () => {
    await openPage();
    await clickMigration();
    const title = target.querySelector<HTMLInputElement>('input[placeholder="Card title"]');
    expect(title).toBeInstanceOf(HTMLInputElement);
    if (!title) throw new Error('Expected the editor');
    title.value = 'Обновлённая заметка';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    runtime.flushSync();

    await clickSave();

    const expected = migrated.replace('# Карточка 🗂', '# Обновлённая заметка')
      .replace('2026-09-24T00:00:00.000Z', new Date(NOW).toISOString());
    remote.assertUploaded(expected);
    expect(remote.readRemoteSource()).toBe(expected);
    await reopenPage();
    expect(remote.downloads.at(-1)).toBe(expected);
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(target.querySelector<HTMLInputElement>('input[placeholder="Card title"]')?.value).toBe('Обновлённая заметка');
    expect(get(cards.cardStore)?.meta.id).toBe('test-card');
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(false);
  });

  it('shows the button again if an unsaved migration is discarded and remote legacy is reopened', async () => {
    await openPage();
    await clickMigration();
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(remote.readRemoteSource()).toBe(legacy);

    await reopenPage();

    expect(requireButton(/^Обновить формат$/).disabled).toBe(false);
    expect(requireSource().value).toBe(legacy);
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(true);
    expect(remote.uploads).toEqual([]);
  });

  it('opens current v1 without a migration button and preserves its exact timestamps and empty list type', async () => {
    remote = mockCardDocumentHttp(v1);
    await openPage();
    const expected = parseMarkdownDocument(v1);
    expect(expected.status).toBe('success');
    if (expected.status !== 'success') throw new Error('Expected a valid fixture');
    // Positive evidence that the current format was read completely, in
    // addition to the absence of a button (which alone already passes today).
    expect(get(cards.cardStore)).toMatchObject(expected.document.card);
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(false);
    expect(target.querySelector<HTMLInputElement>('input[placeholder="Card title"]')?.value).toBe('Карточка 🗂');
  });

  it('saves an already migrated note as v1 without requiring the update button', async () => {
    remote = mockCardDocumentHttp(v1);
    await openPage();
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    await clickSave();
    remote.assertUploaded(v1);
    expect(remote.readRemoteSource()).toBe(v1);
  });

  it('keeps legacy source and disabled Save when migration cannot represent image alt text', async () => {
    remote = mockCardDocumentHttp(legacyWithAlt);
    await openPage();
    await clickMigration();
    expect(requireSource().value).toBe(legacyWithAlt);
    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(/неподдерживаем|не поддерживается/i);
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(true);
    expect(findButton(/^Обновить формат$/)).toBeInstanceOf(HTMLButtonElement);
    expect(target.querySelector('input[placeholder="Card title"]')).toBeNull();
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(legacyWithAlt);
  });
});

describe('unsupported documents stay readable without an unsafe editor', () => {
  it.each([
    ['future version', future],
    ['unknown metadata', unknownMetadata],
    ['invalid timestamp', v1.replace('2026-09-25T12:34:56.789Z', '2026-09-25')],
    ['malformed version marker', v1.replace('markdown-cards: 1', 'markdown-cards: nope')]
  ])('shows the complete %s source and a reason, with no migration or enabled Save', async (_, source) => {
    remote = mockCardDocumentHttp(source);
    await openPage();
    expect(requireSource().value).toBe(source);
    const alert = target.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent?.trim()).toBeTruthy();
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(requireButton(/^(Save|Сохранить)$/).disabled).toBe(true);
    expect(target.querySelector('input[placeholder="Card title"]')).toBeNull();
    expect(remote.uploads).toEqual([]);
  });

  it('also retains unknown source when switching to Markdown view', async () => {
    remote = mockCardDocumentHttp(unknownMetadata);
    await openPage();
    requireButton(/^Switch to Markdown View$/).click();
    runtime.flushSync();
    expect(requireSource().value).toBe(unknownMetadata);
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    expect(remote.uploads).toEqual([]);
  });
});
