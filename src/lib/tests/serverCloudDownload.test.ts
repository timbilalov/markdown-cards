// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mockHttp } from './helpers/http';
import { runHandle } from './helpers/serverRequest';
import { issueSession } from '../server/session';
import legacy from './fixtures/migration-legacy.md?raw';
import v1 from './fixtures/v1-card.md?raw';
import future from './fixtures/unsupported-version.md?raw';

const privateEnvironment = vi.hoisted(() => {
  const state: { values: Readonly<Record<string, string | undefined>> } = { values: {} };
  return state;
});
vi.mock('$env/dynamic/private', () => ({ get env() { return privateEnvironment.values; } }));
// Preserve the middleware sequence in the SSRF regression; credential checking
// is unused there, while logger output is an external side-effect boundary.
vi.mock('../server/auth', () => ({ validateCredentials: vi.fn() }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const token = 'download-private-test-token';
const root = 'notes/Мои карточки';
const filename = 'renamed.md.note.md'; // Deliberately differs from the Card ID.
const href = 'https://downloader.disk.yandex.ru/disk/test-source?signature=test-only';
const settings = { CLOUD_STORAGE_PROVIDER: 'yandex', YANDEX_DISK_TOKEN: token, YANDEX_DISK_BASE_PATH: root, SESSION_SECRET: '22'.repeat(32) };
let http: ReturnType<typeof mockHttp>;
let openDatabase: ReturnType<typeof vi.spyOn>;

function apiUrl(path = filename, folder = root): string {
  return 'https://cloud-api.yandex.net/v1/disk/resources/download'
    + `?path=${encodeURIComponent(`disk:/${folder}/${path}`)}`;
}

function event(query: string): RequestEvent {
  const url = new URL(`/api/cloud/download${query}`, 'https://app.example.invalid');
  return {
    request: new Request(url), url, params: {}, locals: {},
    cookies: { get: (name: string) => name === 'auth_token' ? issueSession('test-user').token : undefined, set: vi.fn() },
    getClientAddress: () => '127.0.0.1', route: { id: '/api/cloud/download' }
  } as unknown as RequestEvent;
}

async function resolveDownload(request: RequestEvent): Promise<Response> {
  const { GET } = await import('../../routes/api/cloud/download/+server');
  return GET({ ...request, route: { id: '/api/cloud/download' }, params: {} });
}

function query(path = filename): string { return `?path=${encodeURIComponent(path)}`; }

function serve(source: string, path = filename, folder = root): void {
  http.on('GET', apiUrl(path, folder), () => Response.json({ href, method: 'GET', templated: false }));
  http.on('GET', href, () => new Response(source));
}

async function expectSource(response: Response, source: string): Promise<void> {
  expect(response.status).toBe(200);
  // Response.text() removes a UTF-8 BOM. Check the actual response bytes.
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(source));
  expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
}

async function expectError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(await response.json()).toEqual({ success: false, error });
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
}

beforeEach(() => {
  vi.resetModules();
  privateEnvironment.values = { ...settings };
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  http = mockHttp();
  openDatabase = vi.spyOn(indexedDB, 'open');
});
afterEach(() => {
  http.assertHandled();
  expect(openDatabase).not.toHaveBeenCalled();
});

describe('GET /api/cloud/download: exact document through the private cloud port', () => {
  it.each([
    ['v1', v1], ['legacy', legacy], ['future format', future], ['empty file', ''],
    ['BOM, CRLF and trailing whitespace', '\uFEFF# Заметка 🗂\r\n\r\nТекст  \r\n\t']
  ])('returns %s unchanged without parsing, migrating or caching it', async (_label, source) => {
    serve(source);
    await expectSource(await resolveDownload(event(query())), source);
    expect(http.fetch).toHaveBeenNthCalledWith(1, apiUrl(), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
    expect(http.fetch).toHaveBeenNthCalledWith(2, href, {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'manual',
      headers: { Accept: 'application/octet-stream', Authorization: `OAuth ${token}` }
    });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('decodes a Unicode filename once and ignores client credentials/root/provider overrides', async () => {
    const path = 'Заметка & планы #1.md';
    serve(legacy, path);
    await expectSource(await resolveDownload(event(query(path)
      + '&provider=memory&root=outside&token=request-test-token')), legacy);
    expect(http.fetch.mock.calls.map(([url]) => String(url))).toEqual([apiUrl(path), href]);
    expect(new Headers(http.fetch.mock.calls[0][1]?.headers).get('Authorization')).toBe(`OAuth ${token}`);
  });

  it('uses fresh configuration and source on the next request, without a cached port', async () => {
    serve(legacy);
    await expectSource(await resolveDownload(event(query())), legacy);
    const nextRoot = 'next-notes';
    privateEnvironment.values = { ...settings, YANDEX_DISK_BASE_PATH: nextRoot, YANDEX_DISK_TOKEN: 'next-test-token' };
    serve(v1, filename, nextRoot);
    await expectSource(await resolveDownload(event(query())), v1);
    expect(http.fetch.mock.calls.map(([url]) => String(url))).toEqual([apiUrl(), href, apiUrl(filename, nextRoot), href]);
    expect(new Headers(http.fetch.mock.calls[2][1]?.headers).get('Authorization')).toBe('OAuth next-test-token');
  });
});

describe('GET /api/cloud/download: filename validation and URL refusal', () => {
  it.each([
    '', '?path=', '?path=note.md&path=other.md', '?url=https%3A%2F%2Fexample.invalid',
    '?path=note.md&url=', query('../outside.md'), query('folder/note.md'),
    query('disk:/notes/note.md'), query('https://example.invalid/note.md'),
    query('note%2fother.md'), query('bad\u0000.md'), query('readme.txt')
  ])('rejects %j with an explicit invalid-path response before cloud HTTP', async value => {
    await expectError(await resolveDownload(event(value)), 400, 'CLOUD_INVALID_PATH');
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('rejects an allowed substring on a foreign URL through the real middleware without sending OAuth', async () => {
    vi.useFakeTimers(); // Middleware starts an interval on import.
    vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-public-test-token');
    const foreignUrl = 'https://example.invalid/file?next=disk.yandex.ru';
    // Allow the old attack to succeed: RED must expose the leak, not a mock error.
    http.on('GET', foreignUrl, () => new Response('private test document'));
    const { handle } = await import('../../hooks.server');
    const response = await runHandle(handle, {
      event: event(`?url=${encodeURIComponent(foreignUrl)}`), resolve: resolveDownload
    });
    await expectError(response, 400, 'CLOUD_INVALID_PATH');
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('refuses an unsafe URL returned by the provider before downloading from it', async () => {
    const foreignUrl = 'https://example.invalid/file?next=disk.yandex.ru';
    http.on('GET', apiUrl(), () => Response.json({ href: foreignUrl, method: 'GET', templated: false }));
    http.on('GET', foreignUrl, () => new Response('private test document'));
    await expectError(await resolveDownload(event(query())), 502, 'CLOUD_INVALID_RESPONSE');
    expect(http.fetch.mock.calls.map(([url]) => String(url))).toEqual([apiUrl()]);
  });

  it('follows a permitted storage redirect without sending it the provider token', async () => {
    serve(legacy);
    const storageUrl = 'https://s123.storage.yandex.net/test-source?signature=test-only';
    http.on('GET', href, () => new Response(null, { status: 302, headers: { Location: storageUrl } }));
    http.on('GET', storageUrl, () => new Response(legacy));
    await expectSource(await resolveDownload(event(query())), legacy);
    expect(http.fetch).toHaveBeenNthCalledWith(3, storageUrl, {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'manual', headers: { Accept: 'application/octet-stream' }
    });
    expect(http.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('GET /api/cloud/download: safe failures distinct from a missing file', () => {
  it.each(['CLOUD_STORAGE_PROVIDER', 'YANDEX_DISK_TOKEN', 'YANDEX_DISK_BASE_PATH'])
    ('requires private %s instead of falling back to the public token', async key => {
      privateEnvironment.values = { ...settings, [key]: undefined };
      vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-public-test-token');
      await expectError(await resolveDownload(event(query())), 503, 'CLOUD_NOT_CONFIGURED');
      expect(http.fetch).not.toHaveBeenCalled();
    });

  it.each([
    [401, 502, 'CLOUD_AUTH_FAILED'], [403, 502, 'CLOUD_AUTH_FAILED'],
    [404, 404, 'CLOUD_NOT_FOUND'], [503, 502, 'CLOUD_REMOTE_ERROR']
  ])('maps download-link API HTTP %i to %i without exposing its body', async (providerStatus, status, error) => {
    http.on('GET', apiUrl(), () => new Response(`Provider details ${token} ${root}`, { status: providerStatus }));
    await expectError(await resolveDownload(event(query())), status, error);
    expect(http.fetch.mock.calls.map(([url]) => String(url))).toEqual([apiUrl()]);
  });

  it('reports an expired download URL as a remote error, not a missing note', async () => {
    serve(legacy);
    http.on('GET', href, () => new Response('Expired test URL', { status: 404 }));
    await expectError(await resolveDownload(event(query())), 502, 'CLOUD_REMOTE_ERROR');
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a listed file whose download fails with HTTP 500 as a remote error without exposing provider diagnostics', async () => {
    serve(v1);
    http.on('GET', href, () => new Response('file IO failure: no successful lookup result', { status: 500 }));
    await expectError(await resolveDownload(event(query())), 502, 'CLOUD_REMOTE_ERROR');
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a network failure without raw diagnostics and can recover on the next request', async () => {
    http.on('GET', apiUrl(), () => { throw new Error(`Network details ${token} ${root}`); });
    await expectError(await resolveDownload(event(query())), 503, 'CLOUD_UNAVAILABLE');
    expect(http.fetch).toHaveBeenCalledTimes(1);
    serve(legacy);
    await expectSource(await resolveDownload(event(query())), legacy);
    expect(http.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['invalid JSON', () => new Response('{')],
    ['invalid schema', () => Response.json({ href, method: 'PUT', templated: false })]
  ])('reports %s as a safe invalid-response error', async (_label, respond) => {
    http.on('GET', apiUrl(), respond);
    await expectError(await resolveDownload(event(query())), 502, 'CLOUD_INVALID_RESPONSE');
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid UTF-8 instead of returning damaged successful text', async () => {
    serve(legacy);
    http.on('GET', href, () => new Response(new Uint8Array([0xc3, 0x28])));
    await expectError(await resolveDownload(event(query())), 502, 'CLOUD_INVALID_RESPONSE');
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
});
