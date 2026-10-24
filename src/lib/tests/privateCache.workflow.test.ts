import { mockHttp } from './helpers/http';
import { mockStorageIdentity, fixtureStorageContext, fileRequests } from './helpers/storageIdentityHttp';
// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';

vi.mock('$env/dynamic/private', () => ({ env: { SESSION_SECRET: '99'.repeat(32), CLOUD_STORAGE_ACTIVE: 'yandex', CLOUD_STORAGES: JSON.stringify([{ id: 'yandex', label: 'Яндекс Диск', provider: 'yandex', accessToken: 'fixture-token', rootPath: 'md-cards' }]) } }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let http: ReturnType<typeof mockHttp>;
let handle: typeof import('../../hooks.server')['handle'];
let token: string;
let openDatabase: ReturnType<typeof vi.spyOn>;
const origin = 'https://app.example.invalid';
const staleHeaders = {
  'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=60',
  'CDN-Cache-Control': 'public, max-age=86400',
  'Vercel-CDN-Cache-Control': 'public, max-age=86400',
  'Surrogate-Control': 'max-age=86400',
  Expires: 'Wed, 01 Jan 2031 00:00:00 GMT',
  ETag: '"old-private-content"',
  'Last-Modified': 'Tue, 01 Sep 2026 00:00:00 GMT'
};

beforeEach(async () => {
  vi.resetModules(); http=mockHttp(); mockStorageIdentity(http);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  vi.stubEnv('NODE_ENV', 'production');
  token = (await import('../server/session')).issueSession('test-user').token;
  handle = (await import('../../hooks.server')).handle;
  openDatabase = vi.spyOn(indexedDB, 'open');
});

afterEach(() => {
  http.assertHandled(); expect(fileRequests(http)).toEqual([]);
  expect(openDatabase).not.toHaveBeenCalled();
});

function event(path: string, options: { method?: string; auth?: boolean; routeId?: string | null; base?: string } = {}): RequestEvent {
  const url = new URL(path, options.base ?? origin);
  const method = options.method ?? 'GET';
  return {
    url, request: new Request(url, { method, headers: { Origin: url.origin, 'X-Storage-Context': fixtureStorageContext() } }),
    cookies: { get: vi.fn(name => name === 'auth_token' && options.auth !== false ? token : undefined) },
    route: { id: options.routeId === undefined ? url.pathname : options.routeId },
    params: {}, locals: {}, getClientAddress: () => '198.18.1.1'
  } as unknown as RequestEvent;
}

function expectPrivate(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  for (const header of Object.keys(staleHeaders).filter(name => name !== 'Cache-Control')) {
    expect(response.headers.has(header), header).toBe(false);
  }
}

describe('Application response boundary for private documents', () => {
  it.each(['/', '/card/existing-note', '/card/private.md', '/api/cloud/download?path=existing-note.md',
    '/api/cloud/files', '/api/files', '/api/cloud/upload', '/markdown/existing-note', '/login'])
    ('overrides cacheable downstream headers on %s without changing content or cookies', async path => {
      const headers = new Headers({ ...staleHeaders, 'Content-Type': 'text/plain; charset=utf-8',
        Vary: 'Accept-Encoding', 'Content-Disposition': 'inline; filename="existing-note.md"' });
      headers.append('Set-Cookie', 'first=one; Path=/; HttpOnly');
      headers.append('Set-Cookie', 'second=two; Path=/; HttpOnly');
      const source = '\uFEFF# Private 🗂\r\n\r\nKeep exact bytes.\r\n';
      const downstream = new Response(source, { headers });
      const resolve = vi.fn(async () => downstream);
      const response = await runHandle(handle, { event: event(path), resolve });

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(response.bodyUsed).toBe(false);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(source));
      expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
      expect(response.headers.get('Vary')).toBe('Accept-Encoding');
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('Content-Disposition')).toBe('inline; filename="existing-note.md"');
      expectPrivate(response);
    });

  it.each([204, 206, 302, 404, 405, 410, 429, 500, 503])
    ('preserves status %s and its payload while preventing storage', async status => {
      const body = status === 204 ? null : 'private-result';
      const headers = new Headers(staleHeaders);
      if (status === 302) headers.set('Location', '/card/other');
      if (status === 429) headers.set('Retry-After', '30');
      if (status === 206) headers.set('Content-Range', 'bytes 0-13/100');
      const response = await runHandle(handle, { event: event('/card/existing-note'),
        resolve: async () => new Response(body, { status, headers }) });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body ?? '');
      for (const header of ['Location', 'Retry-After', 'Content-Range']) {
        expect(response.headers.get(header)).toBe(headers.get(header));
      }
      expectPrivate(response);
    });

  it('covers the early HTTPS redirect without resolving or consuming the request body', async () => {
    const request = event('/api/cloud/upload?path=private.md', { method: 'POST', base: 'http://app.example.invalid' });
    const resolve = vi.fn(async () => new Response('not reached'));
    const response = await runHandle(handle, { event: request, resolve });
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${origin}/api/cloud/upload?path=private.md`);
    expect(request.request.bodyUsed).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it.each([true, false])('covers the rate limiter before auth with authenticated=%s', async auth => {
    const resolve = vi.fn(async () => new Response('allowed'));
    for (let index = 0; index < 100; index++) {
      const accepted = await runHandle(handle, { event: event('/api/auth/login', { auth, method: 'POST' }), resolve });
      expect(accepted.status).toBe(200);
    }
    const response = await runHandle(handle, { event: event('/api/auth/login', { auth, method: 'POST' }), resolve });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');
    expect(await response.json()).toMatchObject({ error: 'RATE_LIMITED', outcome: 'not-written' });
    expect(resolve).toHaveBeenCalledTimes(100);
    expectPrivate(response);
  });

  it('leaves public asset caching intact while protecting a card whose slug looks like an asset', async () => {
    const assetHeaders = { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"asset"' };
    const asset = await runHandle(handle, {
      event: event('/_app/immutable/assets/icon.svg', { routeId: null }),
      resolve: async () => new Response('public-asset', { headers: assetHeaders })
    });
    expect(asset.headers.get('Cache-Control')).toBe(assetHeaders['Cache-Control']);
    expect(asset.headers.get('ETag')).toBe('"asset"');
    expect(await asset.text()).toBe('public-asset');
    const card = await runHandle(handle, {
      event: event('/card/icon.svg', { routeId: '/card/[slug]' }),
      resolve: async () => new Response('private-document', { headers: assetHeaders })
    });
    expect(await card.text()).toBe('private-document');
    expectPrivate(card);
  });
});
