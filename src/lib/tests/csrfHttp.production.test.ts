// @vitest-environment node
import { productionStorageContext,productionFileRequests } from './helpers/productionHttp';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProductionHttp, productionOrigin as origin, productionCredentials,
  productionSessionSecret, readAuthCookie, type ProductionRequest, type ProductionResponse } from './helpers/productionHttp';
import { v1 } from './helpers/markdownReadFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>>;
beforeAll(async () => { server = await createProductionHttp(); }, 90_000);
afterAll(async () => { await server?.close(); });
beforeEach(async () => { await server.reset(); });
afterEach(async () => {
  if (!server) return;
  const response = await server.request({ url: `${origin}/api/auth/status` });
  expect(response.effects.unexpected).toEqual([]);
  expect(response.effects.databaseOpens).toBe(0);
});

type Media = 'json' | 'text' | 'urlencoded' | 'multipart';
const formMedia: Media[] = ['text', 'urlencoded', 'multipart'];
const foreignOrigin = 'https://foreign.example.invalid';

function mutation(path: string, media: Media, source: string | null, cookie?: string,
  accept?: string, method = 'POST', base = origin): ProductionRequest {
  const headers: Record<string, string> = { 'X-Storage-Context': productionStorageContext };
  if (source !== null) headers.Origin = source;
  if (cookie) headers.Cookie = cookie;
  if (accept) headers.Accept = accept;
  const request: ProductionRequest = { url: `${base}${path}`, method, headers };
  if (media === 'multipart') {
    request.form = { content: 'private-body-sentinel' };
  } else if (media === 'urlencoded') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    request.body = new URLSearchParams({ content: 'private-body-sentinel' }).toString();
  } else {
    headers['Content-Type'] = media === 'json' ? 'application/json' : 'text/plain';
    request.body = media === 'json' ? JSON.stringify(productionCredentials) : 'private-body-sentinel';
  }
  return request;
}

function expiredAuthCookie(): string {
  // Independently sign a strictly expired fixture with the synthetic test key.
  const payload = Buffer.from(JSON.stringify({ id: '77'.repeat(16), username: 'test-user',
    issuedAt: 0, expiresAt: 1, rememberMe: false })).toString('base64url');
  const message = `v1.${payload}`;
  const mac = createHmac('sha256', Buffer.from(productionSessionSecret, 'hex')).update(message).digest('base64url');
  return `auth_token=${message}.${mac}`;
}

async function login() {
  const response = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(productionCredentials) });
  expect(response.status).toBe(200);
  return readAuthCookie(response);
}

function expectForbidden(response: ProductionResponse) {
  expect(response.status).toBe(403);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers.location).toBeUndefined();
  expect(JSON.parse(response.text)).toEqual({ error: 'Forbidden', code: 'CSRF_ORIGIN_DENIED' });
  expect(response.cookies).toEqual([]);
  expect(response.bodyUsed).toBe(false);
  expect(productionFileRequests(response)).toEqual([]);
  expect(response.effects.unexpected).toEqual([]);
  expect(response.effects.databaseOpens).toBe(0);
}

describe('production adapter → SvelteKit → application CSRF boundary', () => {
  const refusals = formMedia.flatMap(media => [null, 'null', foreignOrigin].flatMap(source =>
    [undefined, 'text/html', 'application/json'].map(accept => ({ media, source, accept }))));
  it.each(refusals)('matches JSON denial for $media, Origin=$source, Accept=$accept', async ({ media, source, accept }) => {
    const cookie = await login();
    const jsonDenial = await server.request(mutation('/api/auth/logout', 'json', source, cookie, accept));
    const formDenial = await server.request(mutation('/api/auth/logout', media, source, cookie, accept));
    const stillAuthenticated = await server.request({ url: `${origin}/api/auth/status`, headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie } });
    const retry = await server.request(mutation('/api/auth/logout', media, origin, cookie, accept));

    expect(JSON.parse(stillAuthenticated.text)).toEqual({ authenticated: true, username: 'test-user' });
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.text)).toEqual({ message: 'Logout successful' });
    expect(retry.cookies).toHaveLength(2);
    expect(retry.cookies.every(cookie => cookie.includes('Max-Age=0'))).toBe(true);
    expectForbidden(jsonDenial);
    expectForbidden(formDenial);
  });

  const unauthenticated = formMedia.flatMap(media => ['absent', 'unsigned', 'expired'].map(session => ({ media, session })));
  it.each(unauthenticated)('keeps JSON 401 before Origin checking for $media with $session auth', async ({ media, session }) => {
    const cookie = session === 'absent' ? undefined : session === 'unsigned' ? 'auth_token=invented-user' : expiredAuthCookie();
    const responses = await Promise.all([null, 'null', foreignOrigin].flatMap(source =>
      ['json' as Media, media].map(kind => server.request(mutation('/api/cloud/upload', kind, source, cookie)))));
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-type']).toContain('application/json');
      expect(JSON.parse(response.text)).toEqual({ error: 'Not authenticated' });
      expect(response.headers.location).toBeUndefined();
      expect(response.bodyUsed).toBe(false);
      expect(response.cookies).toEqual([]);
      expect(productionFileRequests(response)).toEqual([]);
    }
  });

  it.each(formMedia)('guards public login consistently for %s and allows a subsequent real JSON login', async media => {
    const denied = await server.request(mutation('/api/auth/login', media, foreignOrigin));
    const allowed = await server.request(mutation('/api/auth/login', 'json', origin));
    const cookie = readAuthCookie(allowed);
    const user = await server.request({ url: `${origin}/api/auth/user`, headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie } });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.text)).toEqual({ message: 'Login successful', user: { username: 'test-user' } });
    expect(user.status).toBe(200);
    expect(JSON.parse(user.text)).toEqual({ username: 'test-user' });
    expectForbidden(denied);
  });

  it.each([false, true])('refuses multipart before cloud I/O and retains a same-origin upload with overwrite=%s', async overwrite => {
    const path = 'md-cards/existing-note.md';
    const original: Record<string, string> = overwrite ? { [path]: 'original remote content' } : {};
    await server.reset(original);
    const cookie = await login();
    const source = v1.replace(/\r?\n/g, '\r\n');
    const form = { path: 'existing-note.md', content: source, overwrite: String(overwrite) };
    const deniedRequest = mutation('/api/cloud/upload', 'multipart', foreignOrigin, cookie);
    deniedRequest.form = form;
    const denied = await server.request(deniedRequest);
    const acceptedRequest = mutation('/api/cloud/upload', 'multipart', origin, cookie);
    acceptedRequest.form = form;
    const accepted = await server.request(acceptedRequest);

    expect(denied.effects.remote).toEqual(original);
    expect(denied.effects.writes).toEqual([]);
    expect(accepted.status).toBe(200);
    expect(accepted.effects.writes).toEqual([{ path, source, overwrite }]);
    expect(accepted.effects.remote).toEqual({ [path]: source });
    expect(productionFileRequests(accepted)).toHaveLength(2);
    expectForbidden(denied);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('keeps the application denial for a %s form request', async method => {
    const cookie = await login();
    const jsonDenial = await server.request(mutation('/api/save', 'json', foreignOrigin, cookie, undefined, method));
    const formDenial = await server.request(mutation('/api/save', 'urlencoded', foreignOrigin, cookie, undefined, method));
    expectForbidden(jsonDenial);
    expectForbidden(formDenial);
  });

  it.each(['/api/auth/status', '/api/auth/user'])('does not bypass the uniform guard on an unsafe public-auth request to %s', async path => {
    const denied = await server.request(mutation(path, 'text', foreignOrigin));
    expectForbidden(denied);
  });

  it.each([origin, 'https://preview.example.invalid', 'https://app.example.invalid:8443'])
    ('uses Request URL origin %s, even with conflicting Host/Forwarded headers', async base => {
      const cookie = await login();
      const spoofedHeaders = { Host: 'foreign.example.invalid', 'X-Forwarded-Host': 'foreign.example.invalid',
        'X-Forwarded-Proto': 'https', Forwarded: 'host=foreign.example.invalid;proto=https' };
      const jsonRequest = mutation('/api/auth/logout', 'json', foreignOrigin, cookie, undefined, 'POST', base);
      const formRequest = mutation('/api/auth/logout', 'text', foreignOrigin, cookie, undefined, 'POST', base);
      const matchingRequest = mutation('/api/auth/logout', 'text', base, cookie, undefined, 'POST', base);
      for (const request of [jsonRequest, formRequest, matchingRequest]) Object.assign(request.headers!, spoofedHeaders);
      const jsonDenial = await server.request(jsonRequest);
      const formDenial = await server.request(formRequest);
      const accepted = await server.request(matchingRequest);
      expect(accepted.status).toBe(200);
      expect(JSON.parse(accepted.text)).toEqual({ message: 'Logout successful' });
      expectForbidden(jsonDenial);
      expectForbidden(formDenial);
    });

  it('keeps a private text 403 for page mutations rather than the framework diagnostic', async () => {
    const response = await server.request(mutation('/login', 'urlencoded', foreignOrigin));
    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.text).toBe('Forbidden');
    expect(response.headers.location).toBeUndefined();
    expect(response.cookies).toEqual([]);
    expect(response.bodyUsed).toBe(false);
  });

  it('preserves safe reads and page redirects around a denied form request', async () => {
    const cookie = await login();
    const denied = await server.request(mutation('/api/save', 'urlencoded', null, cookie));
    const status = await server.request({ url: `${origin}/api/auth/status`, headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie } });
    const user = await server.request({ url: `${origin}/api/auth/user`, headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie } });
    const head = await server.request({ url: `${origin}/api/auth/status`, method: 'HEAD', headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie } });
    const page = await server.request({ url: `${origin}/card/note` });
    expect(JSON.parse(status.text)).toEqual({ authenticated: true, username: 'test-user' });
    expect(JSON.parse(user.text)).toEqual({ username: 'test-user' });
    expect(head.status).toBe(200);
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
    expect(page.headers['cache-control']).toBe('private, no-store');
    expectForbidden(denied);
  });
});
