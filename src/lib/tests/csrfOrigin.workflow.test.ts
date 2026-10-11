// @vitest-environment node
import { onCloudUpload } from './helpers/cloudUploadHttp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';
import { mockHttp } from './helpers/http';
import { v1 } from './helpers/markdownReadFixtures';

vi.mock('$env/dynamic/private', () => ({ env: { ADMIN_USERNAME: 'test-user', ADMIN_PASSWORD_HASH: '$2b$04$dOefitQKRsCSxLbUpW2PDOmCn802Xp74FT5jKLLIqfCTxWQZs1cV6', CLOUD_STORAGE_PROVIDER: 'yandex', YANDEX_DISK_TOKEN: 'test-only-token', YANDEX_DISK_BASE_PATH: 'md-cards', SESSION_SECRET: '66'.repeat(32) } }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const origin = 'https://app.example.invalid';
const foreignOrigin = 'https://evil.example.invalid';
const NOW = 1790769600000;
const csrf = '44'.repeat(32); // Legacy double-submit data must not bypass Origin.
const PASSWORD = 'cycle13-test-password';
const credentials = { username: 'test-user', password: PASSWORD };
let handle: typeof import('../../hooks.server')['handle'];
let sessions: typeof import('../server/session');
let login: RequestHandler;
let logout: RequestHandler;
let status: RequestHandler;
let user: RequestHandler;
let upload: RequestHandler;
let logger: typeof import('../utils/logger')['default'];
let http: ReturnType<typeof mockHttp>;
let openDatabase: ReturnType<typeof vi.spyOn>;

function cookieJar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: string, _options: Record<string, unknown>) => { values.set(name, value); }),
    delete: vi.fn((name: string, _options: Record<string, unknown>) => { values.delete(name); })
  };
}

function authenticatedJar() {
  return cookieJar({ auth_token: sessions.issueSession('test-user').token, csrf_token: csrf });
}

// Explicit Origin in each mutation models a browser request. Missing remains missing.
function event(path: string, jar = authenticatedJar(), init: RequestInit = {}, base = origin): RequestEvent {
  const url = new URL(path, base);
  return { url, request: new Request(url, init), cookies: jar, locals: {}, params: {},
    route: { id: path }, getClientAddress: () => '127.0.0.1' } as unknown as RequestEvent;
}

function mutation(path: string, source: string | null, method = 'POST', jar = authenticatedJar()) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
  if (source !== null) headers.set('Origin', source);
  return event(path, jar, { method, headers, body: JSON.stringify({ private: 'request body' }) });
}

async function through(handler: RequestHandler, request: RequestEvent): Promise<Response> {
  return runHandle(handle, { event: request, resolve: current => Promise.resolve(handler(current)) });
}

async function expectForbidden(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.get('Location')).toBeNull();
  expect(await response.json()).toEqual({ error: 'Forbidden', code: 'CSRF_ORIGIN_DENIED' });
}

function logs(): string {
  return JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls], (_key, value) => value instanceof Error ? value.message : value);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'test-only-token');
  http = mockHttp();
  sessions = await import('../server/session');
  logger = (await import('../utils/logger')).default;
  handle = (await import('../../hooks.server')).handle;
  login = (await import('../../routes/api/auth/login/+server')).POST;
  logout = (await import('../../routes/api/auth/logout/+server')).POST;
  status = (await import('../../routes/api/auth/status/+server')).GET;
  user = (await import('../../routes/api/auth/user/+server')).GET;
  const uploadHandler = (await import('../../routes/api/cloud/upload/+server')).POST;
  upload = current => uploadHandler({ ...current, params: {}, route: { id: '/api/cloud/upload' } });
  openDatabase = vi.spyOn(indexedDB, 'open');
});

afterEach(() => {
  http.assertHandled();
  expect(openDatabase).not.toHaveBeenCalled();
});

describe('one strict Origin policy at the application hook', () => {
  it.each([
    ['missing', null], ['opaque', 'null'], ['foreign', foreignOrigin],
    ['sibling subdomain', 'https://other.app.example.invalid'],
    ['wrong scheme', 'http://app.example.invalid'], ['wrong port', 'https://app.example.invalid:444'],
    ['suffix host', 'https://app.example.invalid.evil.invalid'],
    ['userinfo', 'https://user@app.example.invalid'], ['path', `${origin}/path`],
    ['trailing slash', `${origin}/`], ['multiple values', `${origin}, ${foreignOrigin}`],
    ['malformed', 'not-an-origin']
  ])('refuses %s Origin even with a matching legacy cookie/header', async (_name, source) => {
    const jar = authenticatedJar();
    const before = [...jar.values];
    const request = mutation('/api/cards', source, 'POST', jar);
    const resolve = vi.fn(async () => new Response('mutation reached'));
    const response = await runHandle(handle, { event: request, resolve });

    await expectForbidden(response);
    expect(resolve).not.toHaveBeenCalled();
    expect(request.request.bodyUsed).toBe(false);
    expect([...jar.values]).toEqual(before);
    expect(jar.set).not.toHaveBeenCalled();
    expect(jar.delete).not.toHaveBeenCalled();
    expect(http.fetch).not.toHaveBeenCalled();
    expect(logs()).not.toContain(jar.values.get('auth_token'));
    expect(logs()).not.toContain(csrf);
    expect(logs()).not.toContain('request body');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND'])
    ('guards %s and permits a same-origin retry without a CSRF token', async method => {
      const resolve = vi.fn(async () => new Response('accepted'));
      const denied = await runHandle(handle, { event: mutation('/api/cards', foreignOrigin, method), resolve });
      await expectForbidden(denied);
      expect(resolve).not.toHaveBeenCalled();
      const jar = cookieJar({ auth_token: sessions.issueSession('test-user').token });
      const accepted = await runHandle(handle, { event: event('/api/cards', jar, {
        method, headers: { Origin: origin }, body: 'unchanged body'
      }), resolve });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe('accepted');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(jar.set).not.toHaveBeenCalled();
    });

  it.each(['/api/cloud/upload', '/api/cloud/upload/child', '/api/cloud/upload-extra',
    '/api/auth/login', '/api/auth/logout', '/api/auth/status', '/api/auth/user', '/api/save'])
    ('does not exempt unsafe requests to %s', async path => {
      const request = mutation(path, foreignOrigin);
      const resolve = vi.fn(async () => new Response('handler reached'));
      await expectForbidden(await runHandle(handle, { event: request, resolve }));
      expect(resolve).not.toHaveBeenCalled();
      expect(request.request.bodyUsed).toBe(false);
    });

  it.each([undefined, 'text/html', 'application/json'])('uses private JSON 403 regardless of Accept=%s', async accept => {
    const request = event('/api/cards', authenticatedJar(), { method: 'POST', headers: {
      Origin: foreignOrigin, ...(accept ? { Accept: accept } : {})
    } });
    const resolve = vi.fn(async () => new Response('handler reached'));
    await expectForbidden(await runHandle(handle, { event: request, resolve }));
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['json', 'text', 'urlencoded', 'multipart'])('leaves a same-origin %s body readable exactly once by the handler', async kind => {
    let body: BodyInit;
    const headers = new Headers({ Origin: origin });
    if (kind === 'multipart') {
      const form = new FormData();
      form.set('content', 'unchanged content');
      body = form;
    } else if (kind === 'urlencoded') {
      body = new URLSearchParams({ content: 'unchanged content', _csrf: 'obsolete-body-token' });
    } else {
      headers.set('Content-Type', kind === 'json' ? 'application/json' : 'text/plain');
      body = kind === 'json' ? JSON.stringify({ content: 'unchanged content' }) : 'unchanged content';
    }
    const request = event('/api/cards', authenticatedJar(), { method: 'POST', headers, body });
    const reads: { wasUsed: boolean; content: unknown }[] = [];
    const resolve = vi.fn(async (current: RequestEvent) => {
      const wasUsed = current.request.bodyUsed;
      const content = kind === 'multipart' || kind === 'urlencoded'
        ? (await current.request.formData()).get('content')
        : kind === 'json' ? (await current.request.json()).content : await current.request.text();
      reads.push({ wasUsed, content });
      return new Response('accepted');
    });
    const response = await runHandle(handle, { event: request, resolve });
    expect(response.status).toBe(200);
    expect(reads).toEqual([{ wasUsed: false, content: 'unchanged content' }]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request.request.bodyUsed).toBe(true);
  });

  it('does not fall back to Referer, Fetch Metadata or forwarded host headers', async () => {
    const request = mutation('/api/cards', null);
    request.request.headers.set('Referer', `${origin}/card/note`);
    request.request.headers.set('Sec-Fetch-Site', 'same-origin');
    const resolve = vi.fn(async () => new Response('handler reached'));
    await expectForbidden(await runHandle(handle, { event: request, resolve }));
    const forwarded = mutation('/api/cards', foreignOrigin);
    forwarded.request.headers.set('X-Forwarded-Host', 'evil.example.invalid');
    forwarded.request.headers.set('X-Forwarded-Proto', 'https');
    forwarded.request.headers.set('Forwarded', 'host=evil.example.invalid;proto=https');
    await expectForbidden(await runHandle(handle, { event: forwarded, resolve }));
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps authentication necessary and returns 401 before checking protected writes', async () => {
    const resolve = vi.fn(async () => new Response('handler reached'));
    for (const token of [undefined, 'invented-user']) {
      const jar = cookieJar(token ? { auth_token: token, csrf_token: csrf } : {});
      for (const source of [origin, foreignOrigin]) {
        const response = await runHandle(handle, { event: mutation('/api/cards', source, 'POST', jar), resolve });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Not authenticated' });
      }
    }
    await expectForbidden(await runHandle(handle, { event: mutation('/api/cards', foreignOrigin), resolve }));
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not restrict safe reads after rejecting a mutation', async () => {
    const jar = authenticatedJar();
    const resolve = vi.fn(async () => new Response('safe'));
    await expectForbidden(await runHandle(handle, { event: mutation('/api/cards', foreignOrigin, 'POST', jar), resolve }));
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await runHandle(handle, { event: event('/api/cards', jar, { method }), resolve });
      expect(response.status).toBe(200);
    }
    expect(resolve).toHaveBeenCalledTimes(3);
    const page = await runHandle(handle, { event: event('/card/note', cookieJar()), resolve });
    expect(page.status).toBe(302);
    expect(page.headers.get('Location')).toBe('/login');
  });

  it('rejects a cross-origin page mutation without redirecting or reading the body', async () => {
    const request = mutation('/login', foreignOrigin);
    const resolve = vi.fn(async () => new Response('handler reached'));
    const response = await runHandle(handle, { event: request, resolve });
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toBe('Forbidden');
    expect(resolve).not.toHaveBeenCalled();
    expect(request.request.bodyUsed).toBe(false);
  });

  it('uses the local HTTP origin in development without allowing foreign requests', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const jar = authenticatedJar();
    const base = 'http://localhost:5173';
    const resolve = vi.fn(async () => new Response('accepted'));
    const denied = event('/api/cards', jar, { method: 'POST', headers: { Origin: foreignOrigin, 'X-CSRF-Token': csrf } }, base);
    await expectForbidden(await runHandle(handle, { event: denied, resolve }));
    const allowed = event('/api/cards', jar, { method: 'POST', headers: { Origin: base } }, base);
    expect((await runHandle(handle, { event: allowed, resolve })).status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('real auth and upload handlers behind the Origin gate', () => {
  it.each([null, 'null', foreignOrigin])('refuses login from Origin=%s before parsing credentials or setting cookies', async source => {
    const jar = cookieJar();
    const request = mutation('/api/auth/login', source, 'POST', jar);
    // A valid password ensures a bypass would actually create a session.
    request.request = new Request(request.url, {
      method: 'POST', headers: request.request.headers, body: JSON.stringify(credentials)
    });
    const readBody = vi.spyOn(request.request, 'json');
    await expectForbidden(await through(login, request));
    expect(readBody).not.toHaveBeenCalled();
    expect(jar.set).not.toHaveBeenCalled();
    expect(jar.delete).not.toHaveBeenCalled();
    expect(logs()).not.toContain(PASSWORD);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each(['absent', 'unsigned', 'expired', 'valid'])('protects logout for a %s session and permits same-origin cleanup', async kind => {
    const issued = sessions.issueSession('test-user');
    if (kind === 'expired') vi.setSystemTime(issued.session.expiresAt);
    const token = kind === 'unsigned' ? 'invented-user' : issued.token;
    const jar = cookieJar(kind === 'absent' ? {} : { auth_token: token, csrf_token: csrf });
    const before = [...jar.values];
    await expectForbidden(await through(logout, mutation('/api/auth/logout', foreignOrigin, 'POST', jar)));
    expect([...jar.values]).toEqual(before);
    expect(jar.delete).not.toHaveBeenCalled();
    const accepted = await through(logout, event('/api/auth/logout', jar, { method: 'POST', headers: { Origin: origin } }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ message: 'Logout successful' });
    expect(jar.values.size).toBe(0);
    expect(jar.delete).toHaveBeenCalledTimes(2);
    expect(logs()).not.toContain(token);
  });

  it.each([false, true])('refuses a cross-origin multipart upload, then preserves a same-origin retry with overwrite=%s', async overwrite => {
    const filename = 'existing-note.md';
    const source = v1.replace(/\r?\n/g, '\r\n');
    let remote = overwrite ? 'previous remote source' : null;
    const previous = remote;
    const writes: string[] = [];
    const url = 'https://cloud-api.yandex.net/v1/disk/resources/upload'
      + `?path=${encodeURIComponent(`md-cards/${filename}`)}&overwrite=${overwrite}`;
    const href = 'https://upload.example.invalid/csrf-test';
    onCloudUpload(http, url, href, async init => {
      remote = await new Response(init?.body).text();
      writes.push(remote);
      return new Response(null, { status: 201 });
    });
    const jar = authenticatedJar();
    function request(sourceOrigin: string) {
      const form = new FormData();
      form.set('path', filename);
      form.set('content', source);
      form.set('overwrite', String(overwrite));
      return event('/api/cloud/upload', jar, { method: 'POST', headers: { Origin: sourceOrigin }, body: form });
    }
    const denied = request(foreignOrigin);
    const readBody = vi.spyOn(denied.request, 'formData');
    await expectForbidden(await through(upload, denied));
    expect(readBody).not.toHaveBeenCalled();
    expect(denied.request.bodyUsed).toBe(false);
    expect(remote).toBe(previous);
    expect(writes).toEqual([]);
    expect(http.fetch).not.toHaveBeenCalled();
    const accepted = await through(upload, request(origin));
    expect(accepted.status).toBe(200);
    expect(writes).toEqual([source]);
    expect(remote).toBe(source);
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(jar.set).not.toHaveBeenCalled();
  });

  // Successful sign-in must retire the obsolete CSRF cookie and leave a usable session.
  it.each([undefined, false, true])('signs in with rememberMe=%s, retires the old CSRF cookie and keeps the session usable', async rememberMe => {
    const jar = cookieJar({ auth_token: 'old-cookie', csrf_token: 'old-csrf' });
    const response = await through(login, event('/api/auth/login', jar, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...credentials, rememberMe }) }));
    expect(response.status).toBe(200);
    expect(jar.values.has('csrf_token')).toBe(false);
    const token = jar.values.get('auth_token');
    const claims = sessions.verifySession(token);
    expect(claims).toMatchObject({ username: credentials.username, issuedAt: NOW,
      expiresAt: NOW + (rememberMe ? 30 * 24 : 8) * 60 * 60 * 1000, rememberMe: rememberMe ?? false });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({ message: 'Login successful', user: { username: credentials.username } });
    expect(jar.set).toHaveBeenCalledTimes(1);
    const authOptions = jar.set.mock.calls.find(([name]) => name === 'auth_token')?.[2];
    expect(authOptions).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
    expect(authOptions?.expires).toEqual(rememberMe ? new Date(claims!.expiresAt) : undefined);
    expect(authOptions?.maxAge).toBeUndefined();
    expect(jar.delete).toHaveBeenCalledWith('csrf_token', { path: '/', httpOnly: false, secure: true, sameSite: 'strict' });
    jar.set.mockClear();
    jar.delete.mockClear();
    const resolve = vi.fn(async () => new Response('private document'));
    const page = await runHandle(handle, { event: event('/card/note', jar), resolve });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('private document');
    expect(resolve).toHaveBeenCalledTimes(1);
    const statusResponse = await through(status, event('/api/auth/status', jar));
    expect(statusResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(statusResponse.headers.get('Content-Type')).toContain('application/json');
    expect(await statusResponse.json()).toEqual({ authenticated: true, username: credentials.username });
    const userResponse = await through(user, event('/api/auth/user', jar));
    expect(userResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(userResponse.headers.get('Content-Type')).toContain('application/json');
    expect(await userResponse.json()).toEqual({ username: credentials.username });
    expect(jar.set).not.toHaveBeenCalled();
    expect(jar.delete).not.toHaveBeenCalled();
    expect(logs()).not.toContain(token);
    expect(logs()).not.toContain(PASSWORD);
    expect(logs()).not.toContain('66'.repeat(32));
  });
});
