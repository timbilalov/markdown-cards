// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';
import { expectFallbackCsp, expectSecurityHeaders } from './helpers/securityPolicy';

vi.mock('$env/dynamic/private', () => ({ env: { SESSION_SECRET: '99'.repeat(32) } }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const origin = 'https://app.example.invalid';
let handle: typeof import('../../hooks.server')['handle'];
let token: string;
let openDatabase: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  vi.stubEnv('NODE_ENV', 'production');
  token = (await import('../server/session')).issueSession('test-user').token;
  handle = (await import('../../hooks.server')).handle;
  openDatabase = vi.spyOn(indexedDB, 'open');
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(openDatabase).not.toHaveBeenCalled();
});

function event(path: string, options: { method?: string; auth?: boolean; origin?: string; base?: string; routeId?: string | null } = {}): RequestEvent {
  const url = new URL(path, options.base ?? origin);
  const method = options.method ?? 'GET';
  const headers = { Origin: options.origin ?? url.origin, 'X-Forwarded-Proto': url.protocol === 'https:' ? 'http' : 'https' };
  return { url, request: new Request(url, { method, headers,
    body: method === 'POST' ? 'untouched-request' : undefined }),
    cookies: { get: vi.fn(name => name === 'auth_token' && options.auth !== false ? token : undefined) },
    route: { id: options.routeId === undefined ? url.pathname : options.routeId }, params: {}, locals: {},
    getClientAddress: () => '198.18.1.1' } as unknown as RequestEvent;
}

describe('security headers wrap the whole server middleware chain', () => {
  it('allows a normal authenticated refresh with more than a hundred cloud requests', async () => {
    const resolve = vi.fn(async () => new Response('accepted'));
    for (let count = 0; count < 110; count++) {
      expect((await runHandle(handle, { event: event('/api/cloud/files'), resolve })).status).toBe(200);
    }
    expect(resolve).toHaveBeenCalledTimes(110);
  });
  it.each([
    ['HTTPS redirect', '/api/cloud/upload?path=note.md', { method: 'POST', base: 'http://app.example.invalid' }, 301],
    ['signed-out page', '/card/note', { auth: false }, 302],
    ['signed-out API', '/api/cloud/files', { auth: false }, 401],
    ['wrong Origin', '/api/cloud/upload', { method: 'POST', origin: 'https://foreign.example.invalid' }, 403]
  ] as const)('covers %s before resolve without consuming the request or losing service headers', async (_name, path, options, status) => {
    const request = event(path, options);
    const resolve = vi.fn(async () => new Response('unreachable'));
    const response = await runHandle(handle, { event: request, resolve });
    expect(response.status).toBe(status);
    expect(resolve).not.toHaveBeenCalled();
    expect(request.request.bodyUsed).toBe(false);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    if (status === 301) expect(response.headers.get('Location')).toBe(`${origin}/api/cloud/upload?path=note.md`);
    if (status === 302) expect(response.headers.get('Location')).toBe('/login');
    expectSecurityHeaders(response.headers, request.url.protocol === 'https:');
    expectFallbackCsp(response.headers);
  });

  it.each([true, false])('covers rate limiting with authenticated=%s and preserves Retry-After', async auth => {
    const resolve = vi.fn(async () => new Response('accepted'));
    for (let count = 0; count < 100; count++) {
      const response = await runHandle(handle, { event: event('/api/auth/login', { auth, method: 'POST' }), resolve });
      expect(response.status).toBe(200);
    }
    const response = await runHandle(handle, { event: event('/api/auth/login', { auth, method: 'POST' }), resolve });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');
    expect(await response.json()).toMatchObject({ error: 'RATE_LIMITED', outcome: 'not-written' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expectSecurityHeaders(response.headers);
    expectFallbackCsp(response.headers);
  });

  it.each([200, 204, 206, 302, 400, 404, 405, 410, 500, 503])('enforces the header policy on resolved status %i while preserving exact body/cookies', async status => {
    const source = '\uFEFF# Точный текст 😀\r\n';
    const headers = new Headers({ 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'unsafe-url',
      'Permissions-Policy': 'camera=*', 'Content-Type': 'text/plain; charset=utf-8', Vary: 'Accept-Encoding' });
    headers.append('Set-Cookie', 'first=one; Path=/; HttpOnly');
    headers.append('Set-Cookie', 'second=two; Path=/; HttpOnly');
    if (status === 206) headers.set('Content-Range', 'bytes 0-10/100');
    if (status === 302) headers.set('Location', '/card/other');
    const response = await runHandle(handle, { event: event('/api/cloud/files'),
      resolve: async () => new Response(status === 204 ? null : source, { status, headers }) });
    expect(response.status).toBe(status);
    expect(response.bodyUsed).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(status === 204 ? '' : source));
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
    for (const name of ['Content-Type', 'Vary', 'Content-Range', 'Location']) {
      expect(response.headers.get(name)).toBe(headers.get(name));
    }
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expectSecurityHeaders(response.headers);
    expectFallbackCsp(response.headers);
  });

  it('preserves a renderer-generated CSP nonce without appending a second policy', async () => {
    const csp = "default-src 'self'; script-src 'self' 'nonce-framework-test'; frame-ancestors 'none'";
    const response = await runHandle(handle, { event: event('/login'), resolve: async () => new Response(
      '<script nonce="framework-test">boot()</script>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } }) });
    expect(response.headers.get('Content-Security-Policy')).toBe(csp);
    expect(await response.text()).toContain('nonce="framework-test"');
    expectSecurityHeaders(response.headers);
  });

  it('keeps local HTTP development usable without an HSTS header or redirect', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await runHandle(handle, { event: event('/login', { base: 'http://localhost:5173' }),
      resolve: async () => new Response('local login') });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('local login');
    expectSecurityHeaders(response.headers, false);
    expectFallbackCsp(response.headers);
  });

  it('does not turn a public asset response into private/no-store while adding security headers', async () => {
    const headers = { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"public-asset"' };
    const response = await runHandle(handle, { event: event('/_app/immutable/assets/icons.woff2', { routeId: null }),
      resolve: async () => new Response('public-asset', { headers }) });
    expect(await response.text()).toBe('public-asset');
    expect(response.headers.get('Cache-Control')).toBe(headers['Cache-Control']);
    expect(response.headers.get('ETag')).toBe(headers.ETag);
    expectSecurityHeaders(response.headers);
    expectFallbackCsp(response.headers);
  });
});
