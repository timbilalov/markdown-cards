import { installWebLocks } from './helpers/webLocks';
import { readUploadContent } from './helpers/uploadContent';
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { RequestEvent } from '@sveltejs/kit';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';
import { runHandle } from './helpers/serverRequest';
import legacy from './fixtures/migration-legacy.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$env/dynamic/private', () => ({ env: {
  SESSION_SECRET: 'ab'.repeat(32), CLOUD_STORAGE_PROVIDER: 'yandex',
  YANDEX_DISK_TOKEN: 'upload-host-test-token', YANDEX_DISK_BASE_PATH: 'test-notes'
} }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const token = 'upload-host-test-token';
const filename = 'renamed-заметка';
const origin = 'https://app.example.invalid';
// Host family/path shape observed in a read-only provider response on 2026-10-02.
// The path below is synthetic; no signed URL or user document is retained.
const href = 'https://uploader13klg.disk.yandex.net/upload-target/test-only-upload';
let http: ReturnType<typeof mockHttp>;

function uploadApiUrl(overwrite: boolean): string {
  return `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`disk:/test-notes/${filename}.md`)}&overwrite=${overwrite}`;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(Date.parse('2026-10-02T12:00:00Z'));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  installWebLocks(); http = mockHttp({ authenticated: true });
});
afterEach(() => http.assertHandled());

describe('Yandex Disk upload links from the disk.yandex.net host family', () => {
  it.each([
    { mode: 'create only', createOnly: true },
    { mode: 'ordinary write', createOnly: false }
  ])('uploads exact bytes for $mode without forwarding OAuth', async ({ createOnly }) => {
    const adapter = new YandexDiskAdapter({ accessToken: token, rootPath: 'test-notes' });
    const source = '# Заметка 🗂\r\n\r\nТекст  \r\n';
    const apiUrl = uploadApiUrl(!createOnly);
    http.on('GET', apiUrl, () => Response.json({ href, method: 'PUT', templated: false }));
    http.on('PUT', href, () => new Response(null, { status: 201 }));

    expect(await adapter.write({ path: `${filename}.md`, source, createOnly }))
      .toEqual({ status: 'written', revision: null });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch).toHaveBeenNthCalledWith(1, apiUrl, {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
    expect(http.fetch).toHaveBeenNthCalledWith(2, href, {
      method: 'PUT', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode(source)
    });
  });

  it('saves a migrated legacy note through the real server route and confirms its local snapshot', async () => {
    http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [
      { name: `${filename}.md`, path: `${filename}.md` }
    ] } }));
    http.on('GET', `/api/cloud/download?path=${encodeURIComponent(`${filename}.md`)}`, () => new Response(legacy));
    const cards = await import('../stores/cardStore');
    const { dbService } = await import('../services/dbService');
    await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
    const { POST } = await import('../../routes/api/cloud/upload/+server');
    const { handle } = await import('../../hooks.server');
    const { issueSession } = await import('../server/session');
    const cookie = issueSession('test-user').token;
    const statuses: number[] = [];
    let remote = legacy;
    let submitted: FormData | undefined;
    http.on('GET', uploadApiUrl(true), () => Response.json({ href, method: 'PUT', templated: false }));
    http.on('PUT', href, init => {
      remote = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response(null, { status: 201 });
    });
    http.on('POST', '/api/cloud/upload', async init => {
      const request = new Request(`${origin}/api/cloud/upload`, { ...init, headers: { Origin: origin } });
      submitted = await request.clone().formData();
      const event = { request, url: new URL(request.url), params: {}, locals: {},
        route: { id: '/api/cloud/upload' },
        cookies: { get: (name: string) => name === 'auth_token' ? cookie : undefined, set: vi.fn() },
        getClientAddress: () => '127.0.0.1'
      } as unknown as RequestEvent;
      const response = await runHandle(handle, { event,
        resolve: current => Promise.resolve(POST({ ...current, params: {}, route: { id: '/api/cloud/upload' } }))
      });
      statuses.push(response.status);
      return response;
    });

    await cards.loadCard(filename);
    expect(get(cards.cardDocument)).toMatchObject({ status: 'loaded', saveMode: 'update' });
    expect(cards.migrateCurrentCardFormat().status).toBe('success');
    await cards.saveCard(filename, get(cards.cardStore)!);

    expect(statuses).toEqual([200]);
    expect(submitted?.get('path')).toBe(`${filename}.md`);
    expect(submitted?.get('overwrite')).toBe('true');
    expect(remote).toBe(await readUploadContent(submitted!));
    expect(remote).toContain('<!-- markdown-cards: 1 -->');
    expect(await dbService.getLocalMarkdownSnapshot(filename)).toBeNull();
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'update' });
    expect(get(cards.cardSaveError)).toBeNull();
    expect(get(cards.cardSaveMessage)).toMatch(/сохранено.*Диске/i);
    const uploads = http.fetch.mock.calls.filter(([url]) => url === href);
    expect(uploads).toHaveLength(1);
    expect(uploads[0][1]?.redirect).toBe('error');
    expect(new Headers(uploads[0][1]?.headers).has('Authorization')).toBe(false);
  });
});
