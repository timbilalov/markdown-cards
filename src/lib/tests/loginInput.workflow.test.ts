// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSync } from 'bcryptjs';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';
import { mockHttp } from './helpers/http';
import { invalidLoginBytes, invalidLoginFields, loginCredentials, loginOrigin as origin,
  loginRecoveryCredentials } from './helpers/loginInputFixtures';

const configuration = vi.hoisted(() => ({ username: '', passwordHash: '', secret: 'ab'.repeat(32) }));
vi.mock('$env/dynamic/private', () => ({ get env() { return { ADMIN_USERNAME: configuration.username, ADMIN_PASSWORD_HASH: configuration.passwordHash, SESSION_SECRET: configuration.secret }; } }));
// Real credentials/bcrypt/session/route/hooks; only synthetic configuration and logs.
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let handle: typeof import('../../hooks.server')['handle'];
let login: RequestHandler;
let sessions: typeof import('../server/session');
let logger: typeof import('../utils/logger')['default'];
let validateCredentials: ReturnType<typeof vi.spyOn>;
let openDatabase: ReturnType<typeof vi.spyOn>;
let http: ReturnType<typeof mockHttp>;

function cookieJar() {
  const values = new Map([['auth_token', 'existing-session-value'], ['csrf_token', 'old-csrf-value']]);
  return { values, get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: string, _options: Record<string, unknown>) => { values.set(name, value); }),
    delete: vi.fn((name: string, _options: Record<string, unknown>) => { values.delete(name); }) };
}

function request(body: BodyInit, headers: HeadersInit = {}) {
  const requestHeaders = new Headers({ Origin: origin, 'Content-Type': 'application/json' });
  new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
  return new Request(`${origin}/api/auth/login`, { method: 'POST',
    headers: requestHeaders, body });
}

async function through(input: Request) {
  const jar = cookieJar();
  const before = new Map(jar.values);
  const event = { url: new URL(input.url), request: input, cookies: jar, locals: {}, params: {},
    route: { id: '/api/auth/login' }, getClientAddress: () => '127.0.0.1' } as unknown as RequestEvent;
  const response = await runHandle(handle, { event, resolve: current => Promise.resolve(login(current)) });
  return { response, jar, before };
}

function expectPrivate(response: Response) {
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Location')).toBeNull();
}

async function expectRefusal(result: Awaited<ReturnType<typeof through>>) {
  const { response, jar, before } = result;
  expect(response.status).toBe(400);
  expectPrivate(response);
  expect(await response.json()).toEqual({ message: 'Invalid login request.' });
  expect(validateCredentials, 'Invalid schema/encoding must be refused before bcrypt').not.toHaveBeenCalled();
  expect(jar.set).not.toHaveBeenCalled();
  expect(jar.delete).not.toHaveBeenCalled();
  expect(jar.values).toEqual(before);
  // Invalid input should not reach credential-attempt logging either.
  expect(logger.info).not.toHaveBeenCalledWith('Failed login attempt', expect.anything());
  expect(logger.error).not.toHaveBeenCalled();
  expect(http.fetch).not.toHaveBeenCalled();
}

async function expectRecovery(index = 0) {
  const credentials = loginRecoveryCredentials[index % loginRecoveryCredentials.length];
  const rememberMe = index % 2 === 0;
  configuration.username = credentials.username;
  configuration.passwordHash = hashSync(credentials.password, 4);
  // Escaped single keys and arbitrary ordering remain valid; key-like text in
  // string values must not be counted as duplicate JSON object members.
  const body = `{"password":${JSON.stringify(credentials.password)},"\\u0075sername":${JSON.stringify(credentials.username)},"rememberMe":${rememberMe}}`;
  const { response, jar } = await through(request(body));
  expect(response.status).toBe(200);
  expectPrivate(response);
  expect(await response.json()).toEqual({ message: 'Login successful', user: { username: credentials.username } });
  expect(validateCredentials).toHaveBeenCalledExactlyOnceWith(credentials.username, credentials.password);
  const claims = sessions.verifySession(jar.values.get('auth_token'));
  expect(claims).toMatchObject({ username: credentials.username, rememberMe });
  expect(jar.set).toHaveBeenCalledWith('auth_token', expect.any(String), expect.objectContaining({
    path: '/', httpOnly: true, secure: true, sameSite: 'strict',
    expires: rememberMe ? new Date(claims!.expiresAt) : undefined
  }));
  expect(jar.values.has('csrf_token')).toBe(false);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(1790769600000);
  vi.stubEnv('NODE_ENV', 'production');
  configuration.username = loginCredentials.username;
  configuration.passwordHash = hashSync(loginCredentials.password, 4);
  configuration.secret = 'ab'.repeat(32);
  http = mockHttp();
  validateCredentials = vi.spyOn(await import('../server/auth'), 'validateCredentials');
  sessions = await import('../server/session');
  logger = (await import('../utils/logger')).default;
  handle = (await import('../../hooks.server')).handle;
  login = (await import('../../routes/api/auth/login/+server')).POST;
  openDatabase = vi.spyOn(indexedDB, 'open');
});
afterEach(() => {
  http.assertHandled();
  expect(http.fetch).not.toHaveBeenCalled();
  expect(openDatabase).not.toHaveBeenCalled();
});

describe('strict login fields before credential validation and cookies', () => {
  it.each(invalidLoginFields.map((scenario, index) => ({ ...scenario, index })))
    ('refuses $name and permits an exact valid retry', async ({ body, index }) => {
      await expectRefusal(await through(request(body)));
      await expectRecovery(index);
    });

  it.each(invalidLoginBytes)('refuses $name rather than authenticating replacement text', async ({ bytes }) => {
    await expectRefusal(await through(request(new Uint8Array(bytes))));
    // Literal U+FFFD is valid Unicode; reject the encoding, not this character.
    await expectRecovery(5);
  });

  it('keeps Origin/media/body-size guards before schema and schema before session configuration', async () => {
    const body = JSON.stringify({ ...loginCredentials, extra: 'synthetic-input-marker' });
    const cases: { headers: Record<string, string>; body: string; status: number }[] = [
      { headers: { Origin: 'https://foreign.example.invalid' }, body, status: 403 },
      { headers: { 'Content-Type': 'text/plain' }, body, status: 415 },
      { headers: {}, body: body + ' '.repeat(16 * 1024), status: 413 }
    ];
    for (const scenario of cases) {
      const input = request(scenario.body, scenario.headers);
      const { response, jar, before } = await through(input);
      expect(response.status).toBe(scenario.status);
      expectPrivate(response);
      if (scenario.status !== 413) expect(input.bodyUsed).toBe(false);
      expect(jar.values).toEqual(before);
      expect(jar.set).not.toHaveBeenCalled();
      expect(jar.delete).not.toHaveBeenCalled();
      expect(validateCredentials).not.toHaveBeenCalled();
    }
    configuration.secret = '';
    await expectRefusal(await through(request(body)));
    configuration.secret = 'ab'.repeat(32);
    await expectRecovery();
  });
});
