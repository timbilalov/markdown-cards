import { mockStorageIdentity, fixtureStorageContext, fileRequests } from './helpers/storageIdentityHttp';
import { installWebLocks } from './helpers/webLocks';
import { readUploadContent } from './helpers/uploadContent';
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { RequestEvent } from '@sveltejs/kit';
import { mockHttp } from './helpers/http';
import { runHandle } from './helpers/serverRequest';
import { v1 } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$env/dynamic/private', () => ({ env: {
  SESSION_SECRET: 'ab'.repeat(32), CLOUD_STORAGE_ACTIVE: 'yandex', CLOUD_STORAGES: JSON.stringify([{ id: 'yandex', label: 'Яндекс Диск', provider: 'yandex', accessToken: 'save-private-test-token', rootPath: 'save-notes' }])
} }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const origin = 'https://app.example.invalid';
const existingFilename = 'renamed-заметка';
const href = 'https://uploader1d.dst.yandex.net/upload-target/save?signature=test-only';
let http: ReturnType<typeof mockHttp>;
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];
let statuses: number[];
let remote: string | null;
let bodyAtUpload: string | null;
let mode: string | null;
let uploadStatus: number | 'lost';
let serverDatabaseCalls: number[];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(Date.parse('2026-10-02T12:00:00Z'));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  installWebLocks(); http = mockHttp({ authenticated: true }); mockStorageIdentity(http, 'save-notes');
  http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [] } }));
  statuses = []; remote = null; bodyAtUpload = null; mode = null; uploadStatus = 201; serverDatabaseCalls = [];
  cards = await import('../stores/cardStore');
  db = (await import('../services/dbService')).dbService;
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  const { POST } = await import('../../routes/api/cloud/upload/+server');
  const { issueSession } = await import('../server/session');
  const { handle } = await import('../../hooks.server');
  const cookie = issueSession('test-user').token;
  http.on('POST', '/api/cloud/upload', async init => {
    const request = new Request(`${origin}/api/cloud/upload`, { ...init, headers: { Origin: origin, 'X-Storage-Context': fixtureStorageContext('save-notes') } });
    const fields = await request.clone().formData();
    bodyAtUpload = await readUploadContent(fields);
    mode = String(fields.get('overwrite'));
    const name = String(fields.get('path'));
    const url = `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`disk:/save-notes/${name}`)}&overwrite=${mode}`;
    http.on('GET', url, () => Response.json({ href, method: 'PUT', templated: false }));
    http.on('PUT', href, body => {
      if (uploadStatus === 409) return new Response(null, { status: 409 });
      remote = new TextDecoder().decode(body?.body as Uint8Array);
      if (uploadStatus === 'lost') throw new Error('response lost after commit');
      return new Response(null, { status: uploadStatus });
    });
    const event = { request, url: new URL(request.url), params: {}, locals: {}, route: { id: '/api/cloud/upload' },
      cookies: { get: (name: string) => name === 'auth_token' ? cookie : undefined, set: vi.fn() },
      getClientAddress: () => '127.0.0.1' } as unknown as RequestEvent;
    const open = vi.spyOn(indexedDB, 'open');
    const response = await runHandle(handle, { event, resolve: current => Promise.resolve(POST({ ...current, params: {}, route: { id: '/api/cloud/upload' } })) });
    serverDatabaseCalls.push(open.mock.calls.length);
    open.mockRestore();
    statuses.push(response.status);
    return response;
  });
});
afterEach(() => http.assertHandled());

async function open(kind: 'new' | 'existing' | 'migrated') {
  if (kind === 'new') { cards.openNewCard(); return get(cards.cardStore)!.meta.id; }
  const source = kind === 'existing' ? v1 : legacy;
  remote = source;
  http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [{ name: `${existingFilename}.md`, path: `${existingFilename}.md` }] } }));
  http.on('GET', `/api/cloud/download?path=${encodeURIComponent(`${existingFilename}.md`)}`, () => new Response(source));
  await cards.loadCard(existingFilename);
  expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', saveMode: 'update' });
  if (kind === 'migrated') expect(cards.migrateCurrentCardFormat().status).toBe('success');
  return existingFilename;
}

describe('browser Save → real middleware/upload → private adapter', () => {
  it.each(['new', 'existing', 'migrated'] as const)('saves %s without a client token and acknowledges only that snapshot', async kind => {
    const filename = await open(kind);
    const draft = get(cards.cardStore)!;
    await cards.saveCard(filename, draft);
    expect(statuses).toEqual([200]);
    expect(mode).toBe(kind === 'new' ? 'false' : 'true');
    expect(remote).toBe(bodyAtUpload);
    expect(remote).toContain('<!-- markdown-cards: 1 -->');
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'update' });
    expect(get(cards.cardSaveError)).toBeNull();
    expect(get(cards.cardSaveMessage)).toMatch(/сохранено.*Яндекс Диск/i);
    expect(serverDatabaseCalls).toEqual([0]);
    const providerCalls = fileRequests(http).filter(([url]) => String(url).startsWith('https://'));
    expect(providerCalls).toHaveLength(2);
    expect(String(providerCalls[0][0])).toContain(encodeURIComponent(`disk:/save-notes/${filename}.md`));
    expect(new Headers(providerCalls[0][1]?.headers).get('Authorization')).toBe('OAuth save-private-test-token');
    expect(new Headers(providerCalls[1][1]?.headers).has('Authorization')).toBe(false);
  });

  it.each([202, 'lost'] as const)('retains a migrated local snapshot when provider result is %s', async result => {
    const filename = await open('migrated');
    uploadStatus = result;
    await cards.saveCard(filename, get(cards.cardStore)!);
    expect(statuses).toEqual([503]);
    expect(await db.getLocalMarkdownSnapshot(filename)).toMatchObject({ filename, saveMode: 'update', source: expect.any(String) });
    expect(get(cards.cardSaveMessage)).toBeNull();
    expect(get(cards.cardSaveError)).toMatch(/локально.*(неизвестен|конфликт)/i);
    expect(remote).toBe(bodyAtUpload);
    expect(http.fetch.mock.calls.filter(([url]) => String(url) === href)).toHaveLength(1);
    expect(serverDatabaseCalls).toEqual([0]);
  });

  it('keeps a colliding new draft in create mode instead of replacing the remote file', async () => {
    const filename = await open('new');
    remote = 'Existing cloud source'; uploadStatus = 409;
    await cards.saveCard(filename, get(cards.cardStore)!);
    expect(statuses).toEqual([409]);
    expect(remote).toBe('Existing cloud source');
    expect(mode).toBe('false');
    expect(await db.getLocalMarkdownSnapshot(filename)).toMatchObject({ filename, saveMode: 'create' });
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'create' });
    expect(get(cards.cardSaveMessage)).toBeNull();
    expect(get(cards.cardSaveError)).toMatch(/локально.*(неизвестен|конфликт)/i);
  });
});
