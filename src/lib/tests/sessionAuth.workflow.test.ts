// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';

const privateEnvironment = vi.hoisted(() => {
  const state: { values: Readonly<Record<string, string | undefined>> } = { values: {} };
  return state;
});
vi.mock('$env/dynamic/private', () => ({ get env() { return { ADMIN_USERNAME: 'test-user', ADMIN_PASSWORD_HASH: '$2b$04$dOefitQKRsCSxLbUpW2PDOmCn802Xp74FT5jKLLIqfCTxWQZs1cV6', ...privateEnvironment.values }; } }));
// Real validateCredentials + bcrypt, with a synthetic cost-4 test hash. No .env I/O.
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const NOW = 1790769600000;
const SECRET = '33'.repeat(32);
const PASSWORD = 'cycle13-test-password';
const credentials = { username: 'test-user', password: PASSWORD };
const csrf = '44'.repeat(32);
const ip = '127.0.0.1';
let handle: typeof import('../../hooks.server')['handle'];
let login: RequestHandler;
let status: RequestHandler;
let user: RequestHandler;
let logout: RequestHandler;
let sessions: typeof import('../server/session');
let logger: typeof import('../utils/logger')['default'];
let openDatabase: ReturnType<typeof vi.spyOn>;

// Only the framework's cookie jar and request-event plumbing are substituted.
function cookieJar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: string, _options: Record<string, unknown>) => { values.set(name, value); }),
    delete: vi.fn((name: string, _options: Record<string, unknown>) => { values.delete(name); })
  };
}

function event(path: string, cookies = cookieJar(), init: RequestInit = {}): RequestEvent {
  const url = new URL(path, 'https://app.example.invalid');
  // Model browser-generated Origin; this suite checks sessions, not CSRF refusals.
  const headers = new Headers(init.headers);
  if (init.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method)) headers.set('Origin', url.origin);
  return { url, request: new Request(url, { ...init, headers }), cookies, locals: {}, params: {},
    route: { id: path }, getClientAddress: () => ip } as unknown as RequestEvent;
}

function postLogin(body: unknown = credentials, cookies = cookieJar()) {
  return event('/api/auth/login', cookies, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function through(handler: RequestHandler, request: RequestEvent): Promise<Response> {
  return runHandle(handle, { event: request, resolve: async current => handler(current) });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Content-Type')).toContain('application/json');
}

function logs(): string {
  return JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls], (_key, value) => value instanceof Error ? value.message : value);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  // bcrypt's scheduling stays real; only the middleware interval and time are fixed.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NODE_ENV', 'production');
  privateEnvironment.values = { SESSION_SECRET: SECRET };
  sessions = await import('../server/session');
  logger = (await import('../utils/logger')).default;
  handle = (await import('../../hooks.server')).handle;
  login = (await import('../../routes/api/auth/login/+server')).POST;
  status = (await import('../../routes/api/auth/status/+server')).GET;
  user = (await import('../../routes/api/auth/user/+server')).GET;
  logout = (await import('../../routes/api/auth/logout/+server')).POST;
  openDatabase = vi.spyOn(indexedDB, 'open');
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(openDatabase).not.toHaveBeenCalled();
});

describe('login issues the verified session and retains the existing browser response shape', () => {
  // Three login-success cases moved to csrfOrigin.workflow.test.ts when retiring the CSRF cookie.

  it('issues a session-only cookie suitable for local HTTP development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const jar = cookieJar();
    const response = await login(postLogin(credentials, jar));
    expect(sessions.verifySession(jar.values.get('auth_token'))).toMatchObject({ username: credentials.username });
    expect(response.status).toBe(200);
    expect(jar.set).toHaveBeenCalledWith('auth_token', expect.any(String),
      expect.objectContaining({ path: '/', httpOnly: true, secure: false, sameSite: 'strict' }));
  });

  it.each([undefined, '', 'invalid-key'])('fails explicitly without issuing cookies when the private key is %j', async secret => {
    privateEnvironment.values = { SESSION_SECRET: secret };
    vi.stubEnv('SESSION_SECRET', SECRET);
    const jar = cookieJar();
    const response = await through(login, postLogin(credentials, jar));
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ message: 'Authentication is not configured.' });
    expect(jar.set).not.toHaveBeenCalled();
    expect(logs()).not.toContain(PASSWORD);
    expect(logs()).not.toContain(SECRET);
  });

  it.each([
    ['string rememberMe', { ...credentials, rememberMe: 'false' }],
    ['object username', { ...credentials, username: { name: 'test-user' } }],
    ['numeric password', { ...credentials, password: 7 }],
    ['null payload', null],
    ['array payload', [credentials]]
  ])('rejects malformed login input: %s', async (_label, payload) => {
    const jar = cookieJar();
    const response = await through(login, postLogin(payload, jar));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toEqual({ message: 'Invalid login request.' });
    expect(jar.set).not.toHaveBeenCalled();
    expect(logs()).not.toContain(PASSWORD);
  });

  it('treats malformed JSON as a private 400 response without issuing cookies', async () => {
    const jar = cookieJar();
    const response = await through(login, event('/api/auth/login', jar, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
    }));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toEqual({ message: 'Invalid login request.' });
    expect(jar.set).not.toHaveBeenCalled();
  });

  it('keeps wrong-password and missing-field refusals private and cannot mint a session after either', async () => {
    const jar = cookieJar();
    const wrong = await through(login, postLogin({ ...credentials, password: 'wrong-test-password' }, jar));
    expectPrivate(wrong);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ message: 'Invalid username or password.' });
    const missing = await through(login, postLogin({ username: credentials.username }, jar));
    expectPrivate(missing);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ message: 'Username and password are required.' });
    expect(jar.set).not.toHaveBeenCalled();
    expect(logs()).not.toContain('wrong-test-password');
  });
});

function invalidCookie(kind: string): string {
  const issued = sessions.issueSession('test-user');
  switch (kind) {
    case 'unsigned': return 'invented-user';
    case 'malformed': return 'v1.bad.bad';
    case 'tampered': {
      const parts = issued.token.split('.');
      parts[1] = Buffer.from(JSON.stringify({ ...issued.session, username: 'forged-user' })).toString('base64url');
      return parts.join('.');
    }
    case 'expired': vi.setSystemTime(issued.session.expiresAt); return issued.token;
    case 'rotated key': privateEnvironment.values = { SESSION_SECRET: '55'.repeat(32) }; return issued.token;
    case 'missing key': privateEnvironment.values = {}; return issued.token;
    default: throw new Error('Unknown test scenario');
  }
}

describe('middleware authenticates the cookie before reaching protected routes', () => {
  it.each(['unsigned', 'malformed', 'tampered', 'expired', 'rotated key', 'missing key'])
    ('refuses %s on pages and API routes without invoking their handlers', async kind => {
      const token = invalidCookie(kind);
      const jar = cookieJar({ auth_token: token });
      const resolve = vi.fn(async () => new Response('private document'));
      const page = await runHandle(handle, { event: event('/card/note', jar), resolve });
      expect(page.status).toBe(302);
      expect(page.headers.get('Location')).toBe('/login');
      expect(page.headers.get('Cache-Control')).toBe('private, no-store');
      const api = await runHandle(handle, { event: event('/api/cloud/files', jar), resolve });
      expect(api.status).toBe(401);
      expectPrivate(api);
      expect(api.headers.get('Location')).toBeNull();
      expect(await api.json()).toEqual({ error: 'Not authenticated' });
      expect(resolve).not.toHaveBeenCalled();
      expect(jar.set).not.toHaveBeenCalled();
      expect(logs()).not.toContain(token);
    });

  it('returns JSON 401 rather than a login redirect for an API request with no cookie', async () => {
    const resolve = vi.fn(async () => new Response('private'));
    const response = await runHandle(handle, { event: event('/api/cloud/download?path=note.md'), resolve });
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'Not authenticated' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['/api/cloud/upload', '/api/cards'])('refuses an unsigned session before a write, even with matching CSRF: %s', async path => {
    const jar = cookieJar({ auth_token: 'invented-user', csrf_token: csrf });
    const request = event(path, jar, { method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'text/plain' }, body: 'private test source' });
    const resolve = vi.fn(async () => new Response('write accepted'));
    const response = await runHandle(handle, { event: request, resolve });

    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'Not authenticated' });
    expect(resolve).not.toHaveBeenCalled();
    expect(request.request.bodyUsed).toBe(false);
    expect(jar.set).not.toHaveBeenCalled();
  });

  it.each(['/api/auth/login-extra', '/api/auth/status/child', '/api/auth/user-extra',
    '/api/auth/logout/child', '/favicon.ico/private'])('does not exempt a prefix match: %s', async path => {
    const resolve = vi.fn(async () => new Response('private'));
    const response = await runHandle(handle, { event: event(path), resolve });
    expect(response.status).toBe(path.startsWith('/api/') ? 401 : 302);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([false, true])('logs the verified username and never renews rememberMe=%s from a forged Cookie expiry', async rememberMe => {
    const issued = sessions.issueSession('test-user', rememberMe);
    const jar = cookieJar({ auth_token: issued.token, csrf_token: csrf });
    const resolve = vi.fn(async () => new Response('private'));
    const response = await runHandle(handle, { event: event('/card/note', jar, {
      headers: { Cookie: `auth_token=${issued.token}; csrf_token=${csrf}; Expires=Wed, 01 Jan 2099 00:00:00 GMT` }
    }), resolve });
    expect(logger.info).toHaveBeenCalledWith('Authenticated request',
      { username: 'test-user', ip, path: '/card/note' });
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(jar.set).not.toHaveBeenCalled();
    expect(logs()).not.toContain(issued.token);
    expect(logs()).not.toContain(csrf);
    vi.setSystemTime(issued.session.expiresAt);
    const expired = await runHandle(handle, { event: event('/card/note', jar), resolve });
    expect(expired.status).toBe(302);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('status/user handlers derive identity from the verified session, including direct invocation', () => {
  it.each(['unsigned', 'malformed', 'tampered', 'expired', 'rotated key', 'missing key'])
    ('does not expose or authenticate %s cookies', async kind => {
      const token = invalidCookie(kind);
      const jar = cookieJar({ auth_token: token });
      const statusResponse = await status(event('/api/auth/status', jar));
      expect(await statusResponse.json()).toEqual({ authenticated: false, username: null });
      expect(statusResponse.status).toBe(200);
      expectPrivate(statusResponse);
      const userResponse = await user(event('/api/auth/user', jar));
      expect(userResponse.status).toBe(401);
      expectPrivate(userResponse);
      expect(await userResponse.json()).toEqual({ error: 'Not authenticated' });
      expect(jar.set).not.toHaveBeenCalled();
      expect(logs()).not.toContain(token);
    });

  it('returns only username for a valid session, without reflecting the bearer value', async () => {
    const issued = sessions.issueSession('test-user');
    const jar = cookieJar({ auth_token: issued.token });
    const statusResponse = await status(event('/api/auth/status', jar));
    expect(await statusResponse.json()).toEqual({ authenticated: true, username: 'test-user' });
    expectPrivate(statusResponse);
    const userResponse = await user(event('/api/auth/user', jar));
    expect(await userResponse.json()).toEqual({ username: 'test-user' });
    expectPrivate(userResponse);
    expect(jar.set).not.toHaveBeenCalled();
    expect(logs()).not.toContain(issued.token);
  });
});

describe('logout clears browser cookies without trusting or logging their contents', () => {
  it('logs verified identity, deletes both cookies and makes the same browser unauthenticated', async () => {
    const issued = sessions.issueSession('test-user');
    const jar = cookieJar({ auth_token: issued.token, csrf_token: csrf });
    const response = await through(logout, event('/api/auth/logout', jar, { method: 'POST' }));
    expect(logger.info).toHaveBeenCalledWith('User logged out', { username: 'test-user', ip: 'unknown' });
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({ message: 'Logout successful' });
    expect(jar.delete.mock.calls).toEqual([
      ['auth_token', { path: '/', httpOnly: true, secure: true, sameSite: 'strict' }],
      ['csrf_token', { path: '/', httpOnly: false, secure: true, sameSite: 'strict' }]
    ]);
    expect(jar.values.size).toBe(0);
    expect(logs()).not.toContain(issued.token);
    const statusResponse = await through(status, event('/api/auth/status', jar));
    expect(await statusResponse.json()).toEqual({ authenticated: false, username: null });
    const resolve = vi.fn(async () => new Response('private'));
    const page = await runHandle(handle, { event: event('/card/note', jar), resolve });
    expect(page.status).toBe(302);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['unsigned', 'expired', 'missing key'])('clears a %s cookie idempotently without an identity log', async kind => {
    const token = invalidCookie(kind);
    const jar = cookieJar({ auth_token: token, csrf_token: csrf });
    const response = await through(logout, event('/api/auth/logout', jar, { method: 'POST' }));
    expect(logger.info).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(jar.values.size).toBe(0);
    expect(jar.delete).toHaveBeenCalledTimes(2);
    const again = await through(logout, event('/api/auth/logout', jar, { method: 'POST' }));
    expect(again.status).toBe(200);
    expectPrivate(again);
    expect(logs()).not.toContain(token);
  });
});
