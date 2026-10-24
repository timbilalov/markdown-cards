import { historicalStorage } from './helpers/historicalStorage';
import { saveRepositoryPrototype } from './helpers/saveRepository';
import { onDocumentDownload } from './helpers/documentDownloadHttp';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { v1, futureV1Shape } from './helpers/markdownReadFixtures';
import { mockNewCardDocumentHttp } from './helpers/newCardDocumentHttp';
import { NOW } from './helpers/fixtures';
import legacy from './fixtures/migration-legacy.md?raw';
import migrated from './fixtures/migration-v1.md?raw';

const filename = 'recovered.md.note';
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store');
  return { page: readable({ params: { slug: 'recovered.md.note' } }) };
});

let remote: ReturnType<typeof mockNewCardDocumentHttp>;
let db: typeof import('../services/dbService')['dbService'];
let cards: typeof import('../stores/cardStore');
let runtime: typeof import('svelte');
let CardPage: typeof import('../../routes/card/[slug]/+page.svelte')['default'];
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  remote = mockNewCardDocumentHttp();
  runtime = await import('svelte');
  cards = await import('../stores/cardStore');
  db = (await import('../services/dbService')).dbService;
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  CardPage = (await import('../../routes/card/[slug]/+page.svelte')).default;
  remote.http.fetch.mockClear();
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.remove();
  remote.http.assertHandled();
});

function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  remote.setFailure('network');
}

function seedRemote(source: string) {
  remote.files.set(`${filename}.md`, source);
  onDocumentDownload(remote.http, { name: `${filename}.md`, file: `https://downloader.disk.yandex.ru/${filename}.md` },
    () => new Response(remote.files.get(`${filename}.md`)));
}

async function openPage() {
  component = runtime.mount(CardPage, { target });
  runtime.flushSync();
  await runtime.tick();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(get(cards.cardLoading)).toBe(false);
    expect(target.querySelector('.loading')).toBeNull();
  });
}

async function reopenPage() {
  if (component) await runtime.unmount(component);
  component = undefined;
  target.replaceChildren();
  await openPage();
}

function findButton(label: RegExp) {
  return [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => label.test(button.textContent?.trim() ?? ''));
}

function requireButton(label: RegExp) {
  const button = findButton(label);
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!button) throw new Error('Expected a rendered button');
  return button;
}

function requireTitle() {
  const title = target.querySelector<HTMLInputElement>('input[placeholder="Card title"]');
  expect(title).toBeInstanceOf(HTMLInputElement);
  if (!title) throw new Error('Expected an editable card');
  return title;
}

function requireSource() {
  const source = target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Исходный Markdown"]');
  expect(source).toBeInstanceOf(HTMLTextAreaElement);
  if (!source) throw new Error('Expected readable original source');
  expect(source.readOnly).toBe(true);
  return source;
}

function editTitle(value: string) {
  const title = requireTitle();
  title.value = value;
  title.dispatchEvent(new Event('input', { bubbles: true }));
  runtime.flushSync();
}

async function clickSave() {
  const button = requireButton(/^Save$/);
  expect(button.disabled).toBe(false);
  button.click();
  runtime.flushSync();
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(get(cards.cardSaving)).toBe(false);
  });
}

describe('editor recovery: actual page from cached Markdown', () => {
  it.each([
    ['CLOUD_REMOTE_ERROR', /Облако вернуло ошибку/],
    ['CLOUD_AUTH_FAILED', /авторизации.*облака/],
    ['CLOUD_INVALID_RESPONSE', /некорректный ответ облака/],
    ['CLOUD_UNAVAILABLE', /соединиться с облаком/]
  ])('explains %s when a listed file cannot be downloaded and clears the warning after recovery', async (error, message) => {
    const cached = v1.replace('# Карточка 🗂', '# Cached copy');
    await db.saveMarkdownDocument(filename, cached);
    seedRemote(v1);
    onDocumentDownload(remote.http, { name: `${filename}.md` },
      () => Response.json({ success: false, error }, { status: error === 'CLOUD_UNAVAILABLE' ? 503 : 502 }));

    await openPage();

    expect(requireTitle().value).toBe('Cached copy');
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    expect(target.querySelector('.status-bar .tag.is-warning')?.textContent).toContain('indexeddb');
    expect(target.querySelector('.status-bar .tag.is-success')).toBeNull();
    const warning = target.querySelector('[role="alert"]');
    expect(warning?.textContent).toMatch(message);
    expect(warning?.textContent).toMatch(/локальная копия.*актуальность.*не проверена/i);
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { document: { source: cached } } });
    expect(remote.uploads).toEqual([]);
    cards.cardSaveMessage.set(null);
    runtime.flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(message);

    seedRemote(v1);
    await reopenPage();

    expect(requireTitle().value).toBe('Карточка 🗂');
    expect(get(cards.cardLoadSource)).toBe('cloud');
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector('.status-bar .tag.is-success')?.textContent).toContain('cloud');
  });

  it('explains a Disk download failure without a cached source instead of asking for an unexplained reload', async () => {
    seedRemote(v1);
    onDocumentDownload(remote.http, { name: `${filename}.md` },
      () => Response.json({ success: false, error: 'CLOUD_REMOTE_ERROR' }, { status: 502 }));

    await openPage();

    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(/Облако вернуло ошибку.*Локальная копия отсутствует/);
    expect(target.querySelector('input[placeholder="Card title"]')).toBeNull();
    expect(requireButton(/^Save$/).disabled).toBe(true);
    expect(get(cards.cardLoadSource)).toBeNull();
    expect(remote.uploads).toEqual([]);
  });

  it('clears the cached-load warning when an explicit Save is later confirmed on Disk', async () => {
    await db.saveMarkdownDocument(filename, v1);
    seedRemote(v1);
    onDocumentDownload(remote.http, { name: `${filename}.md` },
      () => Response.json({ success: false, error: 'CLOUD_REMOTE_ERROR' }, { status: 502 }));
    await openPage();
    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(/Облако вернуло ошибку/);

    seedRemote(v1);
    editTitle('Saved after recovery');
    await clickSave();

    expect(remote.files.get(`${filename}.md`)).toContain('# Saved after recovery');
    expect(get(cards.cardLoadWarning)).toBeNull();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/Сохранено.*Яндекс Диск/);
  });

  it('migrates cached legacy explicitly offline, persists on Save and reopens the local v1 without the migration button', async () => {
    const source = legacy.replaceAll('\n', '\r\n');
    const expected = migrated.replace('2026-09-24T00:00:00.000Z', new Date(NOW).toISOString());
    await db.saveMarkdownDocument(filename, source);
    goOffline();

    await openPage();

    expect(requireButton(/^Обновить формат$/).disabled).toBe(false);
    expect(requireSource().value).toBe(legacy); // HTML textarea normalizes CRLF.
    expect(requireButton(/^Save$/).disabled).toBe(true);
    const document = get(cards.cardDocument);
    expect(document && cards.getCardDocumentSource(document)).toBe(source);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    requireButton(/^Обновить формат$/).click();
    runtime.flushSync();
    await runtime.tick();
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(requireTitle().value).toBe('Карточка 🗂');
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    expect(remote.uploads).toEqual([]);

    await clickSave();

    expect(await db.getLocalMarkdownSnapshot(filename)).toEqual({ filename, source: expected, saveMode: 'update', saveId: expect.any(String) });
    expect(remote.uploads).toEqual([]);
    expect(await db.getMarkdownDocument(filename)).toMatchObject({ result: { source } });
    await reopenPage();
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(requireTitle().value).toBe('Карточка 🗂');
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'update',
      result: { status: 'success', document: { source: expected } } });
    expect(remote.uploads).toHaveLength(0);
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/синхронизации|не подтвержд/i);
  });

  it.each([
    ['future version', futureV1Shape],
    ['invalid timestamp', v1.replace('2026-09-25T12:34:56.789Z', 'not-a-date')]
  ])('shows cached %s in both views without editable fields, migration or enabled Save', async (_, source) => {
    await db.saveMarkdownDocument(filename, source);
    goOffline();

    await openPage();

    expect(requireSource().value).toBe(source);
    expect(target.querySelector('input[placeholder="Card title"]')).toBeNull();
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(requireButton(/^Save$/).disabled).toBe(true);
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    requireButton(/Switch to Markdown/).click();
    runtime.flushSync();
    expect(requireSource().value).toBe(source);
    expect(requireButton(/^Save$/).disabled).toBe(true);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
  });

  it('opens cached v1 for offline editing and recovers the explicitly saved edit after reopening', async () => {
    await db.saveMarkdownDocument(filename, v1);
    goOffline();
    const expected = v1.replace('# Карточка 🗂', '# Edited offline');

    await openPage();

    expect(requireTitle().value).toBe('Карточка 🗂');
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(requireButton(/^Save$/).disabled).toBe(false);
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/не провер|не подтвержд/i);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    editTitle('Edited offline');
    await clickSave();
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/локально/i);
    expect(await db.getLocalMarkdownSnapshot(filename)).toEqual({ filename, source: expected, saveMode: 'update', saveId: expect.any(String) });
    await reopenPage();
    expect(requireTitle().value).toBe('Edited offline');
    expect(get(cards.cardLoadSource)).toBe('indexeddb');
    expect(remote.uploads).toHaveLength(0);
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/синхронизации|не подтвержд/i);
  });

  it('reopens an acknowledged Save offline from the updated source cache with no pending or migration state', async () => {
    seedRemote(v1);
    await openPage();
    editTitle('Saved on Disk');
    await clickSave();
    const expected = v1.replace('# Карточка 🗂', '# Saved on Disk');
    expect(remote.files.get(`${filename}.md`)).toBe(expected);
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    goOffline();
    remote.http.fetch.mockClear();

    await reopenPage();

    expect(requireTitle().value).toBe('Saved on Disk');
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'update' });
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/не провер|не подтвержд/i);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
  });

  it.each([['v1', v1], ['legacy', legacy]])('keeps cached %s read-only and disables migration when the remote listing confirms deletion', async (_, source) => {
    await db.saveMarkdownDocument(filename, source);
    // The real listing fixture is empty: successful lookup, absent file.

    await openPage();

    expect(requireSource().value).toBe(source);
    expect(requireButton(/^Save$/).disabled).toBe(true);
    expect(findButton(/^Обновить формат$/)).toBeUndefined();
    expect(target.querySelector('input[placeholder="Card title"]')).toBeNull();
    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(/не найден|отсутствует/i);
    expect(remote.uploads).toEqual([]);
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    // Bypassing the hidden migration action must not enable saving either.
    cards.migrateCurrentCardFormat();
    runtime.flushSync();
    expect(requireButton(/^Save$/).disabled).toBe(true);
    expect(requireSource().value).toBe(source);
  });
});

describe('editor recovery: visible pending state and explicit retries', () => {
  it('restores create mode without auto-upload and refuses to overwrite an existing file on an explicit retry', async () => {
    const source = v1.replace('# Карточка 🗂', '# Recovered new note');
    await historicalStorage.saveLocalMarkdownSnapshot({ filename, source, saveMode: 'create' });
    seedRemote('KEEP-OTHER-DOCUMENT');

    await openPage();

    expect(requireTitle().value).toBe('Recovered new note');
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/синхронизации|не подтвержд/i);
    expect(remote.http.fetch).not.toHaveBeenCalled();
    await clickSave();
    expect(remote.uploads).toEqual([]);
    expect(remote.files.get(`${filename}.md`)).toBe('KEEP-OTHER-DOCUMENT');
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy();
    expect(await db.getLocalMarkdownSnapshot(filename)).toEqual({ filename, source, saveMode: 'create' });
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'create' });
  });

  it('retains a historical update without assuming that its remote base is known', async () => {
    const source = v1.replace('# Карточка 🗂', '# Recovered update');
    await historicalStorage.saveLocalMarkdownSnapshot({ filename, source, saveMode: 'update' });
    seedRemote(v1);

    await openPage();

    expect(requireTitle().value).toBe('Recovered update');
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(target.querySelector('[role="status"]')?.textContent).toMatch(/синхронизации|не подтвержд/i);
    await clickSave();
    expect(remote.uploads).toEqual([]);
    expect(remote.files.get(`${filename}.md`)).toBe(v1);
    expect(await db.getLocalMarkdownSnapshot(filename)).toEqual({ filename, source, saveMode: 'update' });
    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(/заблокирована/i);
  });

  it('shows a local-read error and blocks editing instead of replacing an unreadable snapshot with cloud content', async () => {
    await historicalStorage.saveLocalMarkdownSnapshot({ filename, source: v1, saveMode: 'update' });
    seedRemote(v1);
    vi.spyOn(await saveRepositoryPrototype(), 'readCurrent').mockRejectedValue(new Error('snapshot read aborted'));

    await openPage();

    expect(target.querySelector('[role="alert"]')?.textContent).toEqual(expect.stringContaining('snapshot read aborted'));
    expect(requireButton(/^Save$/).disabled).toBe(true);
    expect(target.querySelector('input[placeholder="Card title"]')).toBeNull();
    expect(remote.http.fetch).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([]);
  });
});
