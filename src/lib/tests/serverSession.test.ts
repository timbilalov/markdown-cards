// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSession, verifySession, type IssuedSession } from '../server/session';

const privateEnvironment = vi.hoisted(() => {
  const state: { values: Readonly<Record<string, string | undefined>> } = { values: {} };
  return state;
});
// Replace Kit's env source and fix the clock; native crypto and session code stay real.
vi.mock('$env/dynamic/private', () => ({ get env() { return privateEnvironment.values; } }));

const NOW = 1790769600000; // 2026-09-30T12:00:00.000Z
const NORMAL_TTL = 8 * 60 * 60 * 1000;
const REMEMBER_TTL = 30 * 24 * 60 * 60 * 1000;
// Public synthetic vectors, not credentials from any local/deployment env.
const SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SECOND_SECRET = 'f0'.repeat(32);
const claims = { id: '0123456789abcdef0123456789abcdef', username: 'test-user',
  issuedAt: NOW, expiresAt: NOW + NORMAL_TTL, rememberMe: false };
// Independently computed with Python stdlib HMAC-SHA256 over v1.<base64url JSON>.
const golden = 'v1.eyJpZCI6IjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmIiwidXNlcm5hbWUiOiJ0ZXN0LXVzZXIiLCJpc3N1ZWRBdCI6MTc5MDc2OTYwMDAwMCwiZXhwaXJlc0F0IjoxNzkwNzk4NDAwMDAwLCJyZW1lbWJlck1lIjpmYWxzZX0.OlQIM93_qdaCxO4YByi20WICIoI0QbNdwUtOan9p6XU';

function signEncoded(payload: string, secret = SECRET, version = 'v1'): string {
  const message = `${version}.${payload}`;
  return `${message}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(message).digest('base64url')}`;
}

// Builds independently signed hostile input; never calls the production issuer.
function signPayload(payload: unknown, secret = SECRET): string {
  return signEncoded(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), secret);
}

function expectIssued(result: IssuedSession, username = 'test-user', rememberMe = false): void {
  // Assert the result before accessing fields: RED must be an assertion, not a TypeError.
  expect(result).toEqual({ token: expect.any(String), session: {
    id: expect.stringMatching(/^[a-f0-9]{32}$/), username, issuedAt: NOW,
    expiresAt: NOW + (rememberMe ? REMEMBER_TTL : NORMAL_TTL), rememberMe
  } });
  const [version, payload, signature] = result.token.split('.');
  expect(result.token.split('.')).toHaveLength(3);
  expect(version).toBe('v1');
  expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual(result.session);
  expect(result.token).toBe(signEncoded(payload));
  expect(verifySession(result.token)).toEqual(result.session);
  expect(result.token).not.toContain(SECRET);
}

let openDatabase: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let warningLog: ReturnType<typeof vi.spyOn>;
let infoLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.setSystemTime(NOW);
  privateEnvironment.values = Object.freeze({ SESSION_SECRET: SECRET });
  // None of these may serve as a fallback for a missing private session secret.
  vi.stubEnv('SESSION_SECRET', SECOND_SECRET);
  vi.stubEnv('VITE_SESSION_SECRET', SECOND_SECRET);
  vi.stubEnv('YANDEX_DISK_TOKEN', SECOND_SECRET);
  openDatabase = vi.spyOn(indexedDB, 'open');
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
  infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(openDatabase).not.toHaveBeenCalled();
  expect(errorLog).not.toHaveBeenCalled();
  expect(warningLog).not.toHaveBeenCalled();
  expect(infoLog).not.toHaveBeenCalled();
});

describe('server session issuance: private key, random identity and absolute expiry', () => {
  it.each([undefined, false, true])('issues a signed session with rememberMe=%s', rememberMe => {
    expectIssued(issueSession('test-user', rememberMe), 'test-user', rememberMe ?? false);
    expect(privateEnvironment.values).toEqual({ SESSION_SECRET: SECRET });
  });

  it('preserves a Unicode username without storing credentials in the payload', () => {
    expectIssued(issueSession('пользователь 🗂'), 'пользователь 🗂');
  });

  it('issues distinct sessions for repeated logins at the same time, independent of returned object mutation', () => {
    const first = issueSession('test-user');
    const second = issueSession('test-user');
    expectIssued(first);
    expectIssued(second);
    expect(first.session.id).not.toBe(second.session.id);
    expect(first.token).not.toBe(second.token);
    first.session.username = 'changed in caller';
    expect(verifySession(first.token)).toMatchObject({ username: 'test-user' });
    expect(verifySession(second.token)).toEqual(second.session);
  });

  it('reads the private key on every call so rotation rejects prior sessions without a module reload', () => {
    expect(verifySession(golden)).toEqual(claims);
    privateEnvironment.values = { SESSION_SECRET: SECOND_SECRET };
    expect(verifySession(golden)).toBeNull();
    const issued = issueSession('test-user');
    expect(issued).toMatchObject({ token: expect.any(String), session: { username: 'test-user' } });
    expect(issued.token).toBe(signPayload(issued.session, SECOND_SECRET));
    expect(verifySession(issued.token)).toEqual(issued.session);
    privateEnvironment.values = { SESSION_SECRET: SECRET };
    expect(verifySession(issued.token)).toBeNull();
    expect(verifySession(golden)).toEqual(claims);
  });

  it('decodes uppercase hex key bytes identically', () => {
    privateEnvironment.values = { SESSION_SECRET: SECRET.toUpperCase() };
    expect(verifySession(golden)).toEqual(claims);
    expectIssued(issueSession('test-user'));
  });

  it.each(['', ' ', ' test-user', 'test-user ', 'bad\nname', 'bad\u0000name', '\ud800', 'a'.repeat(257)])
    ('rejects invalid username %j before issuing a token', username => {
      expect(() => issueSession(username)).toThrow(/^Invalid session input$/);
    });

  it('does not treat a string rememberMe flag as permission for a long-lived session', () => {
    expect(() => issueSession('test-user', 'false' as unknown as boolean)).toThrow(/^Invalid session input$/);
  });
});

describe('server session verification: signed data and time are required', () => {
  it('accepts the independent v1 vector and returns a fresh claims object on each verification', () => {
    const result = verifySession(golden);
    expect(result).toEqual(claims);
    if (result) result.username = 'changed in caller';
    expect(verifySession(golden)).toEqual(claims);
  });

  it.each([false, true])('accepts until the exact absolute expiry, without extending rememberMe=%s', rememberMe => {
    const payload = { ...claims, rememberMe, expiresAt: NOW + (rememberMe ? REMEMBER_TTL : NORMAL_TTL) };
    const token = signPayload(payload);
    vi.setSystemTime(payload.expiresAt - 1);
    expect(verifySession(token)).toEqual(payload);
    vi.setSystemTime(payload.expiresAt);
    expect(verifySession(token)).toBeNull();
    vi.setSystemTime(payload.expiresAt + 1);
    expect(verifySession(token)).toBeNull();
  });

  it.each([
    ['username', { ...claims, username: 'forged-user' }],
    ['expiry', { ...claims, expiresAt: NOW + REMEMBER_TTL }],
    ['rememberMe', { ...claims, rememberMe: true }]
  ])('rejects a changed %s when the original signature is retained', (_field, forged) => {
    const payload = Buffer.from(JSON.stringify(forged)).toString('base64url');
    expect(verifySession(`v1.${payload}.${golden.split('.')[2]}`)).toBeNull();
  });

  it.each([
    ['missing cookie', undefined], ['null cookie', null], ['empty cookie', ''],
    ['unsigned username', 'test-user'], ['non-string', { token: golden }],
    ['foreign key', signPayload(claims, SECOND_SECRET)],
    ['unknown version with a valid signature', signEncoded(golden.split('.')[1], SECRET, 'v2')],
    ['missing signature', golden.slice(0, golden.lastIndexOf('.'))],
    ['extra segment', `${golden}.extra`], ['wrong-length signature', `${golden.slice(0, -1)}`],
    ['padded payload', signEncoded(golden.split('.')[1] + '=')],
    ['padded signature', `${golden}=`],
    ['whitespace', ` ${golden}`], ['oversized cookie', 'v1.' + 'a'.repeat(4096)],
    ['invalid JSON with valid signature', signEncoded(Buffer.from('{').toString('base64url'))],
    // Invalid UTF-8 would become U+FFFD under a permissive Buffer decode.
    ['invalid UTF-8 with valid signature', signEncoded(Buffer.concat([
      Buffer.from(JSON.stringify(claims).replace('test-user', 'MARKER').split('MARKER')[0]),
      Buffer.from([0xff]),
      Buffer.from(JSON.stringify(claims).replace('test-user', 'MARKER').split('MARKER')[1])
    ]).toString('base64url'))]
  ])('fails closed without throwing for %s', (_label, token) => {
    expect(verifySession(token)).toBeNull();
  });

  it.each([
    ['null payload', null], ['array payload', []], ['missing fields', {}],
    ['extra field', { ...claims, role: 'admin' }],
    ['missing identity', { ...claims, id: undefined }],
    ['short identity', { ...claims, id: 'abcd' }],
    ['wrong username type', { ...claims, username: 7 }],
    ['blank username', { ...claims, username: ' ' }],
    ['future issuedAt', { ...claims, issuedAt: NOW + 1, expiresAt: NOW + 1 + NORMAL_TTL }],
    ['already expired', { ...claims, issuedAt: NOW - NORMAL_TTL, expiresAt: NOW }],
    ['reversed times', { ...claims, expiresAt: NOW - 1 }],
    ['fractional timestamp', { ...claims, issuedAt: NOW - 0.5, expiresAt: NOW - 0.5 + NORMAL_TTL }],
    ['string timestamp', { ...claims, issuedAt: String(NOW) }],
    ['unsafe timestamp', { ...claims, expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['extended normal lifetime', { ...claims, expiresAt: NOW + NORMAL_TTL + 1 }],
    ['extended remembered lifetime', { ...claims, rememberMe: true, expiresAt: NOW + REMEMBER_TTL + 1 }],
    ['wrong rememberMe type', { ...claims, rememberMe: 'true' }]
  ])('rejects correctly signed but invalid claims: %s', (_label, payload) => {
    expect(verifySession(signPayload(payload))).toBeNull();
  });
});

describe('session configuration: no public, process or cloud-token fallbacks', () => {
  it.each([undefined, '', ' ', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), SECRET + '\n'])
    ('refuses issuance and authentication with invalid private key %j, then recovers', secret => {
      privateEnvironment.values = { SESSION_SECRET: secret, VITE_SESSION_SECRET: SECRET,
        YANDEX_DISK_TOKEN: SECRET, ADMIN_PASSWORD_HASH: SECRET };
      expect(() => issueSession('test-user')).toThrow(/^Invalid session configuration$/);
      expect(verifySession(golden)).toBeNull();
      privateEnvironment.values = { SESSION_SECRET: SECRET };
      expectIssued(issueSession('test-user'));
      expect(verifySession(golden)).toEqual(claims);
    });
});
